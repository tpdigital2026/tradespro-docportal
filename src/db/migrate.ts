import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Client } from 'pg';

type Queryable = Pick<Client, 'query'>;

/** Applies pending .sql files in name order, each in its own transaction. Returns the names applied. */
export async function applyMigrations(client: Queryable, dir: string): Promise<string[]> {
  await client.query(`create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now())`);
  await client.query(`alter table public._migrations enable row level security`);
  await client.query(`revoke all on public._migrations from anon, authenticated`);
  await client.query('select pg_advisory_lock(727270001)');
  try {
    return await run(client, dir);
  } finally {
    await client.query('select pg_advisory_unlock(727270001)').catch(() => undefined);
  }
}

async function run(client: Queryable, dir: string): Promise<string[]> {
  const done = new Set((await client.query('select name from public._migrations')).rows.map((r: { name: string }) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    await client.query('begin');
    try {
      await client.query(readFileSync(path.join(dir, file), 'utf8'));
      await client.query('insert into public._migrations (name) values ($1)', [file]);
      await client.query('commit');
      applied.push(file);
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    }
  }
  return applied;
}
