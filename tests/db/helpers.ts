import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { connect } from '../../src/db/connect';
import { databaseUrl } from '../../src/db/env';

export const dbAvailable = databaseUrl() !== null;

/** Runs fn in a transaction that is always rolled back, so tests leave no trace. */
export async function withRollback<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await connect();
  try {
    await c.query('begin');
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    await c.end();
  }
}

/** Act as a signed-in user for the rest of the transaction; row level security applies. */
export async function actAs(c: Client, userId: string): Promise<void> {
  await c.query('set local role authenticated');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
}

/** Back to the connection's own role (bypasses row level security, like the server). */
export async function actAsServer(c: Client): Promise<void> {
  await c.query('reset role');
}

export async function createTenantWithUser(c: Client, name: string): Promise<{ tenantId: string; userId: string }> {
  const t = await c.query(
    `insert into public.tenants (name, trade_type, owner_name, owner_title) values ($1, 'roofing', 'Test Owner', 'Director') returning id`,
    [name],
  );
  const tenantId = t.rows[0].id as string;
  const userId = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), now())`,
    [userId, `${userId}@example.test`],
  );
  await c.query(
    `insert into public.profiles (id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Test Owner', $3)`,
    [userId, tenantId, `${userId}@example.test`],
  );
  return { tenantId, userId };
}
