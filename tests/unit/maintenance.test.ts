import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cronAuthorised, handleMaintenance, type MaintenanceDeps } from '../../src/lib/maintenance/cron';
import { classify, sweepOrphansWith, type References } from '../../src/lib/maintenance/orphan-sweep';
import { InMemoryStorage } from '../../src/lib/storage';

const SECRET = 'cron-secret-0123456789-0123456789-abc';
const T = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const J = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const V2 = '45444444-4444-4444-8444-444444444444';
const R = '55555555-5555-4555-8555-555555555555';
const R2 = '56555555-5555-4555-8555-555555555555';
const P = '66666666-6666-4666-8666-666666666666';
const S = '77777777-7777-4777-8777-777777777777';

function deps(over: Partial<MaintenanceDeps> = {}) {
  const order: string[] = [];
  const lines: string[] = [];
  const d: MaintenanceDeps = {
    secret: () => SECRET,
    purgeCustomers: async () => (order.push('purge'), 2),
    purgeLoginAttempts: async () => (order.push('logins'), 7),
    sweep: async (dry) => (order.push(`sweep:${dry}`), { dryRun: dry, tenants: 1, scanned: 3, referenced: 1, young: 1, unknown: 0, orphans: 1, deleted: dry ? 0 : 1 }),
    log: (l) => lines.push(l),
    ...over,
  };
  return { d, order, lines };
}
const get = (auth?: string, q = '') => new Request(`https://app.example.test/api/cron/maintenance${q}`, { headers: auth ? { authorization: auth } : {} });

describe('maintenance cron route', () => {
  it('answers 401 and does nothing without the exact bearer secret, or when the secret is not set', async () => {
    for (const [auth, secret] of [[undefined, SECRET], ['Bearer wrong', SECRET], [`Bearer ${SECRET}x`, SECRET], [SECRET, SECRET], [`bearer ${SECRET}`, SECRET], [`Bearer ${SECRET}`, undefined], ['Bearer short', 'short']] as const) {
      const { d, order } = deps({ secret: () => secret });
      const r = await handleMaintenance(get(auth), d);
      expect(r.status, String(auth)).toBe(401);
      expect(order).toEqual([]);
    }
  });
  it('compares in constant time over hashes (any length), and accepts only the exact value', () => {
    expect(cronAuthorised(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(cronAuthorised(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(cronAuthorised(`Bearer ${'x'.repeat(5000)}`, SECRET)).toBe(false);
    expect(cronAuthorised(null, SECRET)).toBe(false);
  });
  it('runs purge, then sign-in attempts, then the sweep, and logs counts only', async () => {
    const { d, order, lines } = deps();
    const r = await handleMaintenance(get(`Bearer ${SECRET}`), d);
    expect(r.status).toBe(200);
    expect(order).toEqual(['purge', 'logins', 'sweep:false']);
    expect(await r.json()).toMatchObject({ ok: true, purge: { customers: 2 }, loginAttempts: { deleted: 7 }, orphans: { deleted: 1 } });
    expect(lines.join('\n')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
  it('?dry=1 sweeps without deleting', async () => {
    const { d, order } = deps();
    await handleMaintenance(get(`Bearer ${SECRET}`, '?dry=1'), d);
    expect(order).toEqual(['purge', 'logins', 'sweep:true']);
  });
  it('a failed step is reported (500) by name only, and the later steps still run', async () => {
    const { d, order, lines } = deps({ purgeCustomers: async () => { throw Object.assign(new Error('Storage deletion failed for 1111/abc'), { code: 'X1' }); } });
    const r = await handleMaintenance(get(`Bearer ${SECRET}`), d);
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ ok: false, purge: { ok: false }, loginAttempts: { ok: true } });
    expect(order).toEqual(['logins', 'sweep:false']);
    expect(lines.join('\n')).toContain('maintenance purge failed: Error X1');
    expect(lines.join('\n')).not.toContain('1111/abc');
  });
  it('vercel.json schedules it daily at 03:15 UTC', () => {
    const v = JSON.parse(readFileSync(path.join(__dirname, '../../vercel.json'), 'utf8'));
    expect(v.crons).toEqual([{ path: '/api/cron/maintenance', schedule: '15 3 * * *' }]);
  });
});

const refs = (o: Partial<References> = {}): References => ({ paths: new Set(), folders: new Set(), draftVersions: new Set(), ...o });

describe('orphan sweep', () => {
  it('classifies by shape, and never claims a file whose shape it does not know', () => {
    const r = refs({ paths: new Set([`${T}/${C}/${J}/${P}.jpg`, `${T}/brand/signature-${S}.png`]), folders: new Set([`${T}/${C}/${J}/${V}/${R}/`]), draftVersions: new Set([V2]) });
    expect(classify(`${T}/${C}/${J}/${V}/${R}/document.pdf`, T, r)).toBe('referenced');
    expect(classify(`${T}/${C}/${J}/${V}/${R}/page-02.png`, T, r)).toBe('referenced');
    expect(classify(`${T}/${C}/${J}/${V}/${R2}/document.pdf`, T, r)).toBe('orphan');
    expect(classify(`${T}/${C}/${J}/${V}/preview-abc/page-01.png`, T, r)).toBe('orphan');
    expect(classify(`${T}/${C}/${J}/${V2}/preview-abc/pages.json`, T, r)).toBe('referenced');
    expect(classify(`${T}/${C}/${J}/${P}.jpg`, T, r)).toBe('referenced');
    expect(classify(`${T}/${C}/${J}/${R}.jpg`, T, r)).toBe('orphan');
    expect(classify(`${T}/brand/signature-${S}.png`, T, r)).toBe('referenced');
    // Survey photos (the survey task) are job_photos rows at {tenant}/{customer}/{job}/{photo id}.jpg: the same shape.
    const survey = `${T}/${C}/${J}/${S}.jpg`;
    expect(classify(survey, T, refs({ paths: new Set([survey]) }))).toBe('referenced');
    expect(classify(survey, T, r)).toBe('orphan');
    expect(classify(`${T}/brand/signature-${R}.png`, T, r)).toBe('orphan');
    for (const p of [`${T}/logo.png`, `${T}/${C}/notes.txt`, `${T}/${C}/${J}/${V}/${R}/evil.pdf`, `${T}/survey/${R}.jpg`, `${C}/${C}/${J}/${P}.jpg`, `${T}/${C}/../x.jpg`]) {
      expect(classify(p, T, r), p).toBe('unknown');
    }
  });

  it('deletes only unreferenced files older than a day; dry run deletes nothing (fake storage)', async () => {
    const st = new InMemoryStorage();
    const old = new Date('2026-10-01T00:00:00Z');
    const now = new Date('2026-10-15T00:00:00Z');
    const files = {
      kept: `${T}/${C}/${J}/${V}/${R}/document.pdf`,
      orphan: `${T}/${C}/${J}/${V}/${R2}/document.pdf`,
      orphanPage: `${T}/${C}/${J}/${V}/${R2}/page-01.png`,
      young: `${T}/${C}/${J}/${V}/preview-k/page-01.png`,
      unknown: `${T}/somewhere/else.png`,
      noDate: `${T}/${C}/${J}/${R}.jpg`,
    };
    for (const [k, p] of Object.entries(files)) {
      await st.put(p, Buffer.from(k), 'application/octet-stream');
      st.createdAt.set(p, k === 'young' ? new Date('2026-10-14T12:00:00Z') : old);
    }
    st.createdAt.delete(files.noDate);
    const db = {
      query: vi.fn(async (sql: string) => {
        if (/from public\.document_versions/.test(sql)) return { rows: [{ id: V, pdf_path: files.kept, files: null, finalised_at: '2026-10-02' }] };
        return { rows: [] };
      }),
    };
    const dry = await sweepOrphansWith(db, st, { dryRun: true, now, tenantIds: [T] });
    expect(dry).toEqual({ dryRun: true, tenants: 1, scanned: 6, referenced: 1, young: 2, unknown: 1, orphans: 2, deleted: 0 });
    expect(st.blobs.size).toBe(6);
    const live = await sweepOrphansWith(db, st, { dryRun: false, now, tenantIds: [T] });
    expect(live.deleted).toBe(2);
    expect([...st.blobs.keys()].sort()).toEqual([files.kept, files.young, files.unknown, files.noDate].sort());
    // Every query was filtered by the tenant.
    for (const call of db.query.mock.calls) expect(call[0]).toMatch(/tenant_id = \$1/);
  });

  it('a storage failure stops the sweep with an error, having deleted nothing it was unsure of', async () => {
    const st = new InMemoryStorage();
    await st.put(`${T}/${C}/${J}/${V}/${R2}/document.pdf`, Buffer.from('x'), 'application/pdf');
    st.createdAt.set(`${T}/${C}/${J}/${V}/${R2}/document.pdf`, new Date('2026-01-01'));
    st.failNext = true;
    await expect(sweepOrphansWith({ query: async () => ({ rows: [] }) }, st, { dryRun: false, tenantIds: [T] })).rejects.toThrow(/Storage deletion failed/);
    expect(st.blobs.size).toBe(1);
  });
});
