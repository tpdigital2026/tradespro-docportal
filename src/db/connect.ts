import { Client } from 'pg';
import { databaseUrl, redactSecrets } from './env';

export async function connect(): Promise<Client> {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL is not set');
  // Dev tooling; pin the Supabase CA before production.
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
  } catch (e) {
    const err = new Error(redactSecrets(String((e as Error).message ?? e))) as Error & { code?: unknown };
    err.code = (e as { code?: unknown }).code;
    throw err;
  }
  return client;
}
