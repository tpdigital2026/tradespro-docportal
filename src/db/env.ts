import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Parses one .env line for DATABASE_URL: optional `export `, optional surrounding quotes. Null if not that key. */
export function parseEnvLine(line: string): string | null {
  const m = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$/.exec(line.replace(/\r$/, ''));
  if (!m) return null;
  let v = m[1];
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  return v;
}

/** DATABASE_URL from the environment, else from .env.local. Returns null if unset or still a template. */
export function databaseUrl(): string | null {
  const value = process.env.DATABASE_URL || readLocal();
  if (!value || value.includes('YOUR-PASSWORD')) return null;
  return value;
}

function readLocal(): string | undefined {
  const file = path.join(process.cwd(), '.env.local');
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const v = parseEnvLine(line);
    if (v) return v;
  }
  return undefined;
}

/** Removes the connection string and its password from any message, so errors are safe to print. */
export function redactSecrets(message: string): string {
  const url = databaseUrl();
  if (!url) return message;
  const secrets = new Set<string>([url]);
  try {
    const u = new URL(url);
    if (u.password) {
      secrets.add(u.password);
      try {
        secrets.add(decodeURIComponent(u.password));
      } catch {
        /* keep raw only */
      }
    }
  } catch {
    /* not parseable; the whole-URL redaction still applies */
  }
  let out = message;
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(s).join('[redacted]');
  return out;
}
