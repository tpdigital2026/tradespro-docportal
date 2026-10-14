import { Client } from 'pg';
import { databaseUrl } from './env';

export async function connect(): Promise<Client> {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}
