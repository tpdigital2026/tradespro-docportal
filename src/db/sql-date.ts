/**
 * SQL `date` values (doc_date, paid_on) as 'yyyy-mm-dd' strings, never through a Date in UTC.
 *
 * node-postgres's default parser turns a SQL date into LOCAL midnight; `toISOString()` then shifts it to UTC, which on a
 * machine in British Summer Time gives the previous day. Two layers stop that:
 *  - app connections (src/db/connect.ts) use `PG_TYPES`, so a date arrives as the raw text Postgres sent;
 *  - every reader goes through `sqlDate`, which also copes with a Date (another client, a test), reading it with LOCAL
 *    getters, which is exactly how node-postgres built it.
 */
import { types } from 'pg';

const DATE_OID = 1082;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export const PG_TYPES = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === DATE_OID && format !== 'binary') return (v: string) => v;
    return types.getTypeParser(oid, format as 'text');
  },
} as unknown as typeof types;

export function sqlDate(v: unknown): string {
  if (v instanceof Date) {
    return `${String(v.getFullYear()).padStart(4, '0')}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v ?? '');
  return DATE_RE.test(s) ? s.slice(0, 10) : '';
}
