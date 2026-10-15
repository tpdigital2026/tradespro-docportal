/** Runs fn again once if Postgres reports a deadlock (40P01). fn must own its whole transaction, so a retry starts clean. */
export async function retryOnDeadlock<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string } | null)?.code === '40P01') return fn();
    throw e;
  }
}
