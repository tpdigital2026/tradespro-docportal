/**
 * Where customers' stored files (PDFs, photos) live. The erase and purge protocols delete the files
 * before the database rows, inside one transaction, so a failure here must throw.
 */
export interface StorageDeleter {
  /** Deletes every path. Missing objects are not an error. Throws if any deletion fails. */
  deleteStorageObjects(paths: string[]): Promise<void>;
}

/** Holds paths in memory. Used until storage buckets exist, and in tests. */
export class InMemoryStorage implements StorageDeleter {
  readonly objects = new Set<string>();
  readonly deleted: string[] = [];
  /** Test hook: make the next deletion fail. */
  failNext = false;

  async deleteStorageObjects(paths: string[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Storage deletion failed');
    }
    for (const p of paths) {
      this.objects.delete(p);
      this.deleted.push(p);
    }
  }
}

let shared: StorageDeleter | null = null;

/** The storage the app uses. Replace with the real bucket client when buckets exist. */
export function getStorage(): StorageDeleter {
  shared ??= new InMemoryStorage();
  return shared;
}
