import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** DATABASE_URL from the environment, else from .env.local. Returns null if unset or still a template. */
export function databaseUrl(): string | null {
  const fromEnv = process.env.DATABASE_URL;
  const value = fromEnv ?? readLocal();
  if (!value || value.includes('YOUR-PASSWORD')) return null;
  return value;
}

function readLocal(): string | undefined {
  const file = path.join(process.cwd(), '.env.local');
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='));
  return line?.slice('DATABASE_URL='.length).trim();
}
