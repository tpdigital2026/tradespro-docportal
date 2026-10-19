import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS } from '../../src/lib/slug';

const APP = path.join(__dirname, '../../src/app');
// Files that become a top-level URL segment of their own (metadata routes).
const SEGMENT_FILES = new Set(['manifest', 'icon', 'apple-icon', 'robots', 'sitemap', 'favicon', 'opengraph-image', 'twitter-image']);

/** Every routable top-level URL segment under src/app. Route groups "(x)" are transparent, so their children count as top level. */
function topLevelSegments(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.startsWith('(')) out.push(...topLevelSegments(path.join(dir, e.name)));
      else if (!/^[[@_]/.test(e.name)) out.push(e.name); // dynamic ([slug]), parallel (@x) and private (_x) folders are not fixed segments
    } else {
      const base = e.name.replace(/\.[^.]+$/, '');
      if (SEGMENT_FILES.has(base)) out.push(base);
    }
  }
  return out;
}

describe('reserved slugs', () => {
  it('finds the known top-level routes (guards the scanner itself)', () => {
    const found = topLevelSegments(APP);
    expect(found).toEqual(expect.arrayContaining(['api', 'customers', 'dev', 'login']));
  });
  it('reserves every routable top-level segment of src/app, so no business can take a real route as its address', () => {
    const missing = topLevelSegments(APP).filter((s) => !RESERVED_SLUGS.includes(s));
    expect(missing).toEqual([]);
  });
  it('matches the words in the tenants_slug_not_reserved* constraints, as the latest migration defining each leaves them', () => {
    // Each constraint name (tenants_slug_not_reserved, tenants_slug_not_reserved_040, ...) counts as its last definition
    // in migration order, and the reserved words are the union of them all.
    const dir = path.join(__dirname, '../../supabase/migrations');
    const latest = new Map<string, string[]>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      for (const m of sql.matchAll(/add constraint (tenants_slug_not_reserved\w*)\s+check[^;]*?array\[([^\]]+)\]/g)) {
        latest.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
      }
    }
    expect(latest.has('tenants_slug_not_reserved')).toBe(true);
    const fromSql = [...new Set([...latest.values()].flat())].sort();
    expect(fromSql).toEqual([...RESERVED_SLUGS].sort());
    // Every merged task's routes: the business tabs (030) and Owner Settings (040). The survey report added no
    // top-level route (it lives under /documents and /api/surveys).
    expect(fromSql).toEqual(expect.arrayContaining(['pipeline', 'money', 'calendar', 'guarantees', 'settings']));
  });
});
