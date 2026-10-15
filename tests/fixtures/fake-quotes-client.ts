import type { DataClient } from '../../src/lib/data/customers';

type Row = Record<string, unknown>;

/** A tiny in-memory stand-in for the slice of supabase-js the quote data layer uses. */
export function fakeClient(seed: Record<string, Row[]> = {}, opts: { failOn?: (t: string, op: string) => boolean } = {}) {
  const tables: Record<string, Row[]> = { jobs: [], documents: [], document_versions: [], customers: [], used_numbers: [], job_types: [], bank_accounts: [], ...seed };
  let n = 0;
  const log: string[] = [];
  const client: DataClient = {
    from(table: string) {
      const t = (tables[table] ??= []);
      const filters: ((r: Row) => boolean)[] = [];
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      let limit = Infinity;
      const run = () => {
        if (opts.failOn?.(table, op)) return { data: null, error: { message: 'boom', code: 'XX000' } };
        if (op === 'insert') {
          if (table === 'jobs' && t.some((r) => r.reference === payload.reference)) return { data: null, error: { message: 'dup', code: '23505' } };
          const row = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, created_at: new Date(n).toISOString(), status: table === 'documents' ? 'draft' : undefined, ...payload };
          t.push(row);
          log.push(`insert ${table}`);
          return { data: [row], error: null };
        }
        const hit = t.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') {
          hit.forEach((r) => Object.assign(r, payload));
          log.push(`update ${table}`);
          return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        return { data: hit.slice(0, limit), error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        insert: (p: Row) => ((op = 'insert'), (payload = p), b),
        update: (p: Row) => ((op = 'update'), (payload = p), b),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
        order: () => b,
        limit: (x: number) => ((limit = x), b),
        single: () => {
          const r = run();
          return Promise.resolve(r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null });
        },
        maybeSingle: () => {
          const r = run();
          return Promise.resolve(r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null });
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
  };
  return { client, tables, log };
}

