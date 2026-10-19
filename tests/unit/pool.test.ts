import { describe, expect, it, vi } from 'vitest';
import { pooledConnection, type PoolLike } from '../../src/db/pool';
import { withServiceConnection } from '../../src/lib/data/customer-admin';

type Status = 'I' | 'T' | 'E';

function fakePool(script: { fail?: (text: string, n: number) => unknown } = {}) {
  const clients: { id: number; released: unknown[]; status: Status; queries: string[] }[] = [];
  let n = 0;
  const pool: PoolLike = {
    connect: async () => {
      const c = { id: clients.length + 1, released: [] as unknown[], status: 'I' as Status, queries: [] as string[] };
      clients.push(c);
      return {
        query: (async (text: string) => {
          n += 1;
          c.queries.push(text);
          const err = script.fail?.(text, n);
          if (err) throw err;
          if (/^begin/i.test(text)) c.status = 'T';
          if (/^(commit|rollback)/i.test(text)) c.status = 'I';
          return { rows: [], rowCount: 0 };
        }) as never,
        release: (destroy?: unknown) => {
          c.released.push(destroy ?? null);
        },
        getTransactionStatus: () => c.status,
      };
    },
  };
  return { pool, clients };
}

const serverError = () => Object.assign(new Error('duplicate key'), { severity: 'ERROR', code: '23505' });
const socketError = () => Object.assign(new Error('Connection terminated unexpectedly'), {});

describe('pooled service connections', () => {
  it('hands an idle connection back to the pool for reuse', async () => {
    const { pool, clients } = fakePool();
    const db = await pooledConnection(pool);
    await db.query('select 1');
    await db.end();
    expect(clients[0].released).toEqual([null]);
  });

  it('never reuses a connection left inside a transaction', async () => {
    const { pool, clients } = fakePool();
    const db = await pooledConnection(pool);
    await db.query('begin');
    await db.end();
    expect(clients[0].released).toEqual([true]);
  });

  it('keeps a connection after a server-reported error, but throws it away after a socket error', async () => {
    const a = fakePool({ fail: (t) => (t.includes('insert') ? serverError() : null) });
    const db = await pooledConnection(a.pool);
    await db.query('select 1');
    await expect(db.query('insert into x values (1)')).rejects.toThrow('duplicate key');
    await db.end();
    expect(a.clients[0].released).toEqual([null]);

    const b = fakePool({ fail: (t) => (t.includes('update') ? socketError() : null) });
    const db2 = await pooledConnection(b.pool);
    await db2.query('select 1');
    await expect(db2.query('update x set y = 1')).rejects.toThrow('terminated');
    await db2.end();
    expect(b.clients[0].released).toEqual([true]);
  });

  it('retries a stale first statement once on a new connection, only when it cannot have written anything', async () => {
    const a = fakePool({ fail: (_t, n) => (n === 1 ? socketError() : null) });
    const db = await pooledConnection(a.pool);
    await db.query('begin');
    expect(a.clients).toHaveLength(2);
    expect(a.clients[0].released).toEqual([true]);
    await db.query('rollback');
    await db.end();
    expect(a.clients[1].released).toEqual([null]);

    const b = fakePool({ fail: (_t, n) => (n === 1 ? socketError() : null) });
    const db2 = await pooledConnection(b.pool);
    await expect(db2.query('insert into x values (1)')).rejects.toThrow('terminated');
    expect(b.clients).toHaveLength(1);
    await db2.end();
    expect(b.clients[0].released).toEqual([true]);
  });

  it('releases exactly once, however many times end() is called', async () => {
    const { pool, clients } = fakePool();
    const db = await pooledConnection(pool);
    await db.end();
    await db.end();
    expect(clients[0].released).toHaveLength(1);
  });

  it('withServiceConnection always hands the connection back, also when the work throws', async () => {
    const { pool, clients } = fakePool();
    await expect(
      withServiceConnection(async (db) => {
        await db.query('begin');
        throw new Error('boom');
      }, () => pooledConnection(pool)),
    ).rejects.toThrow('boom');
    expect(clients[0].released).toEqual([true]);
    const open = vi.fn(() => pooledConnection(pool));
    expect(await withServiceConnection(async () => 7, open)).toBe(7);
    expect(clients[1].released).toEqual([null]);
  });
});
