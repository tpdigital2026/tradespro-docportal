/**
 * Where customers' stored files (PDFs, page images, photos) live: the private Supabase Storage bucket `documents`
 * (migration 012). Only the server touches it, with the service role key; nobody signed in through the app can read
 * or write it directly. Files are streamed to the owner by our own routes after the session and tenant checks.
 *
 * Paths: `{tenant}/{customer}/{job}/{version}/...`. Keys are never URL-decoded (the database path checks are literal).
 *
 * The erase and purge protocols delete the files before the database rows, inside one transaction, so a failure here
 * must throw.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isDemo } from './demo';

export const DOCUMENTS_BUCKET = 'documents';

export interface StorageDeleter {
  /** Deletes every path. Missing objects are not an error. Throws if any deletion fails. */
  deleteStorageObjects(paths: string[]): Promise<void>;
  /** Deletes everything under a folder (`{tenant}/{customer}/`). Missing is not an error. Throws on failure. */
  deleteStoragePrefix(prefix: string): Promise<void>;
}

export interface DocumentStorage extends StorageDeleter {
  /** Stores bytes at a path. Refuses to overwrite unless `overwrite` is set (preview images may be redrawn). */
  put(path: string, bytes: Buffer, contentType: string, opts?: { overwrite?: boolean }): Promise<void>;
  /** The bytes at a path, or null when there is nothing there. Throws on any other failure. */
  get(path: string): Promise<Buffer | null>;
}

const SAFE_PATH = /^[0-9a-f-]{36}\/[A-Za-z0-9._/-]{1,400}$|^demo-[A-Za-z0-9._/-]{1,400}$/;

/** Paths are built by the server only; this is a last check that nothing odd reaches the bucket. */
export function assertSafePath(path: string): void {
  if (!SAFE_PATH.test(path) || path.includes('..') || path.includes('//') || path.endsWith('/')) throw new Error('Unsafe storage path');
}

/** Holds files in memory. Used in demo mode and in tests. */
export class InMemoryStorage implements DocumentStorage {
  readonly objects = new Set<string>();
  readonly blobs = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly deleted: string[] = [];
  readonly deletedPrefixes: string[] = [];
  /** Test hook: make the next deletion fail. */
  failNext = false;

  async put(path: string, bytes: Buffer, contentType: string, opts: { overwrite?: boolean } = {}): Promise<void> {
    if (!opts.overwrite && this.blobs.has(path)) throw new Error('That file already exists');
    this.objects.add(path);
    this.blobs.set(path, { bytes: Buffer.from(bytes), contentType });
  }

  async get(path: string): Promise<Buffer | null> {
    return this.blobs.get(path)?.bytes ?? null;
  }

  async deleteStorageObjects(paths: string[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Storage deletion failed');
    }
    for (const p of paths) {
      this.objects.delete(p);
      this.blobs.delete(p);
      this.deleted.push(p);
    }
  }

  async deleteStoragePrefix(prefix: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Storage deletion failed');
    }
    for (const p of [...this.objects]) if (p.startsWith(prefix)) this.objects.delete(p);
    for (const p of [...this.blobs.keys()]) if (p.startsWith(prefix)) this.blobs.delete(p);
    this.deletedPrefixes.push(prefix);
  }
}

/** The slice of supabase-js storage used here, so tests can pass a stub. */
export interface BucketApi {
  upload(path: string, body: Buffer, opts: { contentType: string; upsert: boolean }): Promise<{ error: { message: string; statusCode?: string } | null }>;
  download(path: string): Promise<{ data: Blob | null; error: { message: string; statusCode?: string; status?: number } | null }>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
  list(prefix: string, opts: { limit: number; offset: number }): Promise<{ data: { name: string; id: string | null }[] | null; error: { message: string } | null }>;
}

const notFound = (e: { message?: string; statusCode?: string; status?: number } | null): boolean =>
  !!e && (e.statusCode === '404' || e.status === 404 || e.status === 400 || /not.?found|does not exist/i.test(e.message ?? ''));

/** Supabase Storage on the service role. Never logs paths or contents. */
export class SupabaseStorage implements DocumentStorage {
  constructor(private readonly bucket: BucketApi) {}

  async put(path: string, bytes: Buffer, contentType: string, opts: { overwrite?: boolean } = {}): Promise<void> {
    assertSafePath(path);
    const { error } = await this.bucket.upload(path, bytes, { contentType, upsert: opts.overwrite === true });
    if (error) throw new Error('Storage upload failed');
  }

  async get(path: string): Promise<Buffer | null> {
    assertSafePath(path);
    const { data, error } = await this.bucket.download(path);
    if (error) {
      if (notFound(error)) return null;
      throw new Error('Storage download failed');
    }
    return data ? Buffer.from(await data.arrayBuffer()) : null;
  }

  async deleteStorageObjects(paths: string[]): Promise<void> {
    const list = paths.filter((p) => p !== '');
    list.forEach(assertSafePath);
    for (let i = 0; i < list.length; i += 500) {
      const { error } = await this.bucket.remove(list.slice(i, i + 500));
      if (error) throw new Error('Storage deletion failed');
    }
  }

  /** Lists the folder recursively (Supabase lists one level at a time), then removes every file found. */
  async deleteStoragePrefix(prefix: string): Promise<void> {
    if (!/^[0-9a-f-]{36}\/([0-9a-f-]{36}\/)?$/.test(prefix)) throw new Error('Unsafe storage prefix');
    const files: string[] = [];
    const walk = async (folder: string, depth: number): Promise<void> => {
      if (depth > 8) throw new Error('Storage folder is nested too deeply');
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await this.bucket.list(folder.replace(/\/$/, ''), { limit: 1000, offset });
        if (error) throw new Error('Storage listing failed');
        const rows = data ?? [];
        for (const r of rows) {
          const full = `${folder}${r.name}`;
          if (r.id === null) await walk(`${full}/`, depth + 1);
          else files.push(full);
        }
        if (rows.length < 1000) break;
      }
    };
    await walk(prefix, 0);
    await this.deleteStorageObjects(files);
  }
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super('File storage is not configured');
    this.name = 'StorageNotConfiguredError';
  }
}

let shared: DocumentStorage | null = null;

/**
 * The storage the app uses: the private bucket on the service role, or memory in demo mode. Outside demo mode a
 * missing key is an error, never a quiet fallback to memory (files would vanish and erasure would claim success).
 */
export function getStorage(): DocumentStorage {
  if (shared) return shared;
  if (isDemo()) {
    shared = new InMemoryStorage();
    return shared;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new StorageNotConfiguredError();
  const client: SupabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  shared = new SupabaseStorage(client.storage.from(DOCUMENTS_BUCKET) as unknown as BucketApi);
  return shared;
}

/** Test hook. */
export function setStorageForTest(s: DocumentStorage | null): void {
  shared = s;
}
