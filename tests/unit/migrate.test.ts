import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/db/migrate';

// A minimal in-memory stand-in for a pg client, enough to check ordering, idempotency and rollback.
function fakeClient(failOn?: string) {
  const applied = new Set<string>();
  const log: string[] = [];
  return {
    log,
    applied,
    async query(sql: string, params?: unknown[]) {
      log.push(sql.trim().split('\n')[0]);
      if (sql.includes('select name from public._migrations')) return { rows: [...applied].map((name) => ({ name })) };
      if (sql.startsWith('insert into public._migrations')) applied.add(String(params?.[0]));
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      return { rows: [] };
    },
  };
}

function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), 'mig-'));
  for (const [n, s] of Object.entries(files)) writeFileSync(path.join(d, n), s);
  return d;
}

describe('applyMigrations', () => {
  it('applies .sql files in name order and records them', async () => {
    const c = fakeClient();
    const dir = dirWith({ '002_b.sql': 'select 2;', '001_a.sql': 'select 1;', 'notes.txt': 'ignore' });
    expect(await applyMigrations(c as never, dir)).toEqual(['001_a.sql', '002_b.sql']);
    expect([...c.applied]).toEqual(['001_a.sql', '002_b.sql']);
  });
  it('commits per applied file and secures the tracking table', async () => {
    const c = fakeClient();
    const dir = dirWith({ '001_a.sql': 'select 1;', '002_b.sql': 'select 2;' });
    await applyMigrations(c as never, dir);
    expect(c.log.filter((l) => l === 'commit')).toHaveLength(2);
    expect(c.log.some((l) => l.includes('enable row level security'))).toBe(true);
    expect(c.log.some((l) => l.startsWith('revoke all on public._migrations'))).toBe(true);
    expect(c.log.some((l) => l.includes('pg_advisory_lock'))).toBe(true);
    expect(c.log.some((l) => l.includes('pg_advisory_unlock'))).toBe(true);
  });
  it('skips migrations already applied', async () => {
    const c = fakeClient();
    c.applied.add('001_a.sql');
    const dir = dirWith({ '001_a.sql': 'select 1;', '002_b.sql': 'select 2;' });
    expect(await applyMigrations(c as never, dir)).toEqual(['002_b.sql']);
  });
  it('rolls back and rethrows when a migration fails, without recording it', async () => {
    const c = fakeClient('select bad;');
    const dir = dirWith({ '001_a.sql': 'select bad;' });
    await expect(applyMigrations(c as never, dir)).rejects.toThrow('boom');
    expect(c.applied.size).toBe(0);
    expect(c.log).toContain('rollback');
  });
});
