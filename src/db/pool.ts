import { Pool, type PoolClient, type QueryResult } from 'pg';
import { databaseUrl, redactSecrets } from './env';
import { PG_TYPES } from './sql-date';
import { traceConnect, traceQuery } from '../lib/perf/trace';

/**
 * A small pool of service connections, kept warm between requests on the same server instance. Opening a connection
 * costs five or six network round trips (TCP, TLS, start-up, password exchange); reusing one costs none.
 *
 * Nothing about a tenant or a person lives on a connection: every service query names its tenant explicitly, and the
 * transaction helpers clear any JWT claim and role at the start of each transaction. A connection is only handed back
 * when it is idle and outside a transaction ('I'); anything else (an open or failed transaction, a broken socket) is
 * thrown away, never reused.
 */
export interface PooledDb {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}

/** The slice of pg's Pool this module uses, so tests can pass a fake. */
export interface PoolLike {
  connect(): Promise<Pick<PoolClient, 'query' | 'release'> & { getTransactionStatus?(): string | null }>;
}

const KEY = Symbol.for('docportal.service-pool');

function sharedPool(): PoolLike {
  const g = globalThis as unknown as Record<symbol, Pool | undefined>;
  if (!g[KEY]) {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL is not set');
    const pool = new Pool({
      connectionString: url,
      // Dev tooling; pin the Supabase CA before production (as src/db/connect.ts).
      ssl: { rejectUnauthorized: false },
      types: PG_TYPES,
      max: 4,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
    // An idle connection dropped by the server must never crash the process; the pool removes it on its own.
    pool.on('error', () => undefined);
    g[KEY] = pool;
  }
  return g[KEY] as Pool;
}

/** A server-reported error (bad SQL, a constraint) leaves the connection usable; anything else means the socket is suspect. */
const isServerError = (e: unknown) => typeof (e as { severity?: unknown } | null)?.severity === 'string';

/** A first statement that cannot have changed anything, so it is safe to send again on a fresh connection. */
const SAFE_FIRST = /^\s*(begin|select|reset|set|savepoint)\b/i;

/**
 * Checks out one connection. The caller must call end() exactly once (withServiceConnection does). If the very first
 * statement fails because a reused connection had gone stale while the server instance was asleep, and that statement
 * cannot have written anything, it is retried once on a new connection.
 */
export async function pooledConnection(pool: PoolLike = sharedPool()): Promise<PooledDb> {
  let client = await pool.connect();
  traceConnect();
  let broken = false;
  let released = false;
  let first = true;
  const run = async (text: string, values?: unknown[]): Promise<QueryResult> => {
    traceQuery();
    return (await client.query(text, values as unknown[])) as unknown as QueryResult;
  };
  return {
    async query(text, values) {
      const wasFirst = first;
      first = false;
      try {
        return await run(text, values);
      } catch (e) {
        if (isServerError(e)) throw e;
        if (wasFirst && SAFE_FIRST.test(text)) {
          client.release(true);
          client = await pool.connect();
          traceConnect();
          try {
            return await run(text, values);
          } catch (e2) {
            if (!isServerError(e2)) broken = true;
            throw e2;
          }
        }
        broken = true;
        throw e;
      }
    },
    async end() {
      if (released) return;
      released = true;
      const idle = typeof client.getTransactionStatus === 'function' ? client.getTransactionStatus() === 'I' : false;
      client.release(broken || !idle ? true : undefined);
    },
  };
}

/** The default way to open a service connection in the app: pooled. Errors carry no secret. */
export async function openPooled(): Promise<PooledDb> {
  try {
    return await pooledConnection();
  } catch (e) {
    const err = new Error(redactSecrets(String((e as Error).message ?? e))) as Error & { code?: unknown };
    err.code = (e as { code?: unknown }).code;
    throw err;
  }
}
