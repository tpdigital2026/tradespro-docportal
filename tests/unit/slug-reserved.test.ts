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
  it('matches the list in migration 005', () => {
    const sql = readFileSync(path.join(__dirname, '../../supabase/migrations/005_tenant_slug.sql'), 'utf8');
    const m = /tenants_slug_not_reserved[\s\S]*?array\[([^\]]+)\]/.exec(sql);
    const fromSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(fromSql).toEqual([...RESERVED_SLUGS].sort());
  });
});
