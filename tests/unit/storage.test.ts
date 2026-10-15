import { describe, expect, it } from 'vitest';
import { assertSafePath, InMemoryStorage, SupabaseStorage, type BucketApi } from '../../src/lib/storage';

const T = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';

function fakeBucket() {
  const files = new Map<string, Buffer>();
  const calls: string[] = [];
  const api: BucketApi = {
    async upload(path, body, opts) {
      calls.push(`upload ${path}`);
      if (files.has(path) && !opts.upsert) return { error: { message: 'The resource already exists', statusCode: '409' } };
      files.set(path, body);
      return { error: null };
    },
    async download(path) {
      const f = files.get(path);
      return f ? { data: new Blob([new Uint8Array(f)]), error: null } : { data: null, error: { message: 'Object not found', statusCode: '404' } };
    },
    async remove(paths) {
      calls.push(`remove ${paths.length}`);
      paths.forEach((p) => files.delete(p));
      return { error: null };
    },
    async list(prefix) {
      const names = new Map<string, boolean>();
      for (const k of files.keys()) {
        if (!k.startsWith(`${prefix}/`)) continue;
        const rest = k.slice(prefix.length + 1);
        const [first, ...more] = rest.split('/');
        names.set(first, more.length === 0);
      }
      return { data: [...names].map(([name, isFile]) => ({ name, id: isFile ? 'x' : null })), error: null };
    },
  };
  return { api, files, calls };
}

describe('SupabaseStorage', () => {
  it('stores, reads back, refuses to overwrite unless asked, and treats missing as null', async () => {
    const b = fakeBucket();
    const s = new SupabaseStorage(b.api);
    await s.put(`${T}/${C}/a.pdf`, Buffer.from('pdf'), 'application/pdf');
    expect((await s.get(`${T}/${C}/a.pdf`))?.toString()).toBe('pdf');
    await expect(s.put(`${T}/${C}/a.pdf`, Buffer.from('x'), 'application/pdf')).rejects.toThrow();
    await s.put(`${T}/${C}/a.pdf`, Buffer.from('y'), 'application/pdf', { overwrite: true });
    expect(await s.get(`${T}/${C}/missing.pdf`)).toBeNull();
  });

  it('deletes a customer folder recursively, and only that folder', async () => {
    const b = fakeBucket();
    const s = new SupabaseStorage(b.api);
    for (const p of [`${T}/${C}/j/v/document.pdf`, `${T}/${C}/j/v/page-01.png`, `${T}/${C}/j/v/preview-k/page-01.png`, `${T}/other/j/v/document.pdf`]) await s.put(p, Buffer.from('1'), 'image/png');
    await s.deleteStoragePrefix(`${T}/${C}/`);
    expect([...b.files.keys()]).toEqual([`${T}/other/j/v/document.pdf`]);
  });

  it('refuses odd paths and prefixes', async () => {
    const s = new SupabaseStorage(fakeBucket().api);
    expect(() => assertSafePath(`${T}/../x`)).toThrow();
    expect(() => assertSafePath('x/y')).toThrow();
    await expect(s.deleteStoragePrefix('')).rejects.toThrow();
    await expect(s.deleteStoragePrefix(`${T}/../`)).rejects.toThrow();
  });

  it('a failed removal throws, so erasure rolls back', async () => {
    const b = fakeBucket();
    b.api.remove = async () => ({ error: { message: 'down' } });
    await expect(new SupabaseStorage(b.api).deleteStorageObjects([`${T}/a.pdf`])).rejects.toThrow(/deletion failed/);
  });
});

describe('InMemoryStorage', () => {
  it('keeps bytes, deletes by prefix and records it', async () => {
    const s = new InMemoryStorage();
    await s.put('demo-a/b/c.png', Buffer.from('1'), 'image/png');
    await s.put('demo-a/x.png', Buffer.from('1'), 'image/png');
    await s.deleteStoragePrefix('demo-a/b/');
    expect(await s.get('demo-a/b/c.png')).toBeNull();
    expect(await s.get('demo-a/x.png')).not.toBeNull();
    expect(s.deletedPrefixes).toEqual(['demo-a/b/']);
  });
});
