import { Client } from 'pg';
import { databaseUrl, redactSecrets } from './env';
import { PG_TYPES } from './sql-date';

export async function connect(): Promise<Client> {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL is not set');
  // Dev tooling; pin the Supabase CA before production.
  // SQL dates arrive as their own 'yyyy-mm-dd' text, never as local midnight (src/db/sql-date.ts).
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, types: PG_TYPES });
  try {
    await client.connect();
  } catch (e) {
    const err = new Error(redactSecrets(String((e as Error).message ?? e))) as Error & { code?: unknown };
    err.code = (e as { code?: unknown }).code;
    throw err;
  }
  return client;
}
