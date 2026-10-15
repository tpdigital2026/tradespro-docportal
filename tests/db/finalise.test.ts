import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { FJC_COLOURS } from '../../src/db/seed-fjc';
import { FJC_WORDING } from '../../src/db/wording';
import { demoIssuedJobs } from '../../src/lib/demo-data';
import { saveFollowOnWith } from '../../src/lib/data/billing';
import { compactId, purgeExpiredWith } from '../../src/lib/data/customer-admin';
import { DEFAULT_CONFIRMATION } from '../../src/lib/documents/confirmation';
import { DocumentError, finaliseWith, previewWith, reviseWith, type RenderFn } from '../../src/lib/documents/finalise';
import { readToken } from '../../src/lib/documents/read-proof';
import { InMemoryStorage } from '../../src/lib/storage';
import { addBankAccountWith, saveSignatureWith, setSignatureConsentWith } from '../../src/lib/data/settings';
import { encryptBankDetails } from '../../src/security/bank-crypto';
import type { QuoteFormValues } from '../../src/lib/validation/quote';
import { connect } from '../../src/db/connect';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

const SECRET = 's'.repeat(48);
const KEY = randomBytes(32).toString('base64');
const SLUG = `dbt${randomBytes(4).toString('hex')}`;
const BRAND_DIR = path.join(process.cwd(), 'public', 'brands', SLUG);
const nested = { nested: true } as const;

const render: RenderFn = async () => ({ pdf: Buffer.from('%PDF-1.7 test'), pngPages: [Buffer.from('page one'), Buffer.from('page two')] });

interface Fx {
  tenantId: string;
  userId: string;
  customerId: string;
  jobId: string;
  quoteId: string;
  versionId: string;
  reference: string;
}

/** One business set up like FJC (wording, colours, logos, an encrypted bank account) with an approved draft quote. */
async function fixture(c: Client, o: { audited?: boolean } = {}): Promise<Fx> {
  const t = await createTenantWithUser(c, `Fin ${randomBytes(4).toString('hex')}`);
  await c.query(
    `update public.tenants set slug = $2, address_lines = '{Rochester,ME3 9UD}', phone = '01234 000000', email = 'office@example.test', company_number = '00000000', vat_registered = true, vat_number = 'GB 000000000', tagline = 'Tag' where id = $1`,
    [t.tenantId, SLUG],
  );
  await c.query(`insert into public.tenant_defaults (tenant_id, terms) values ($1, $2)`, [t.tenantId, JSON.stringify(FJC_WORDING)]);
  const kit = await c.query(`insert into public.brand_kits (tenant_id, colours) values ($1, $2) returning id`, [t.tenantId, JSON.stringify(FJC_COLOURS)]);
  for (const [kind, file] of [['logo_colour', 'logo.png'], ['logo_white', 'logo_white.png']]) {
    await c.query(`insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, $3, $4)`, [t.tenantId, kit.rows[0].id, kind, `${t.tenantId}/${file}`]);
  }
  const enc = encryptBankDetails({ sortCode: '00-00-00', accountNumber: '00000000' }, Buffer.from(KEY, 'base64'), t.tenantId);
  const bank = await c.query(`insert into public.bank_accounts (tenant_id, account_name, bank_name, sort_code_enc, account_number_enc, last4, is_default) values ($1, 'Test Account', 'Test Bank', $2, $3, $4, true) returning id`, [t.tenantId, enc.sort_code_enc, enc.account_number_enc, enc.last4]);
  const jt = await c.query(`insert into public.job_types (tenant_id, key, label, guarantee_years) values ($1, 'flat_roof', 'Flat roof', 20) returning id`, [t.tenantId]);
  const cust = await c.query(`insert into public.customers (tenant_id, name, address_lines, postcode) values ($1, 'Mr John Smith', '{123 Bromley Road}', 'BR2 8BG') returning id`, [t.tenantId]);
  const reference = `T-${randomBytes(3).toString('hex').toUpperCase()}`;
  const job = await c.query(
    `insert into public.jobs (tenant_id, customer_id, reference, property_address, job_type_id, payment_plan) values ($1, $2, $3, '123 Bromley Road, BR2 8BG', $4, '{"kind":"deposit","pct_bp":3000}') returning id`,
    [t.tenantId, cust.rows[0].id, reference, jt.rows[0].id],
  );
  const base = demoIssuedJobs[0].form;
  const form: QuoteFormValues = { ...base, quoteNumber: reference, customerId: cust.rows[0].id, jobTypeId: jt.rows[0].id, bankAccountId: bank.rows[0].id, date: '2026-10-08' };
  const doc = await c.query(`insert into public.documents (tenant_id, job_id, type, number, doc_date) values ($1, $2, 'quotation', $3, '2026-10-08') returning id`, [t.tenantId, job.rows[0].id, reference]);
  const ver = await c.query(`insert into public.document_versions (tenant_id, document_id, version, input, bank_account_id) values ($1, $2, 1, $3, $4) returning id`, [t.tenantId, doc.rows[0].id, JSON.stringify({ schema: 1, form }), bank.rows[0].id]);
  await c.query(`update public.documents set current_version_id = $1 where id = $2`, [ver.rows[0].id, doc.rows[0].id]);
  if (o.audited !== false) await c.query(`insert into public.audit_log (tenant_id, user_id, action, entity, entity_id, meta) values ($1, $2, 'scope.approve', 'job', $3, $4)`, [t.tenantId, t.userId, compactId(job.rows[0].id), JSON.stringify({ hash: form.scope.copy!.approvalHash })]);
  return { ...t, customerId: cust.rows[0].id, jobId: job.rows[0].id, quoteId: doc.rows[0].id, versionId: ver.rows[0].id, reference };
}

const v_pdf = (r: { rows: { final_content: { files?: string } }[] }) => r.rows[0].final_content.files;
const pdfOf = async (c: Client, id: string) => (await c.query(`select pdf_path from public.documents where id = $1`, [id])).rows[0].pdf_path as string | null;
const under = (st: InMemoryStorage, prefix: string) => [...st.blobs.keys()].filter((k) => k.startsWith(prefix)).sort();

const actor = (f: Fx) => ({ tenantId: f.tenantId, userId: f.userId, role: 'owner' });
const tokens = (f: Fx, documentId: string, versionId: string, key: string, pages = 2) =>
  Array.from({ length: pages }, (_, i) => readToken(SECRET, { tenantId: f.tenantId, userId: f.userId, documentId, versionId, key }, i + 1));

async function previewAndFinalise(c: Client, f: Fx, storage: InMemoryStorage, documentId: string) {
  const p = await previewWith(c, storage, actor(f), documentId, { render, secret: SECRET });
  if (!p.ok) throw new Error(`preview blocked: ${p.missing.join('; ')}`);
  const res = await finaliseWith(c, storage, actor(f), { documentId, versionId: p.preview.versionId, key: p.preview.key, tokens: tokens(f, documentId, p.preview.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested);
  return { p, res };
}

async function expectCode(promise: Promise<unknown>, code: DocumentError['code']) {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof DocumentError && e.code === code);
}

describe.skipIf(!dbAvailable)('finalise', () => {
  beforeAll(() => {
    process.env.BANK_ENCRYPTION_KEY = KEY;
    mkdirSync(BRAND_DIR, { recursive: true });
    copyFileSync(path.join(process.cwd(), 'public', 'brands', 'fjc', 'logo.png'), path.join(BRAND_DIR, 'logo.png'));
    copyFileSync(path.join(process.cwd(), 'public', 'brands', 'fjc', 'logo_white.png'), path.join(BRAND_DIR, 'logo_white.png'));
  });
  afterAll(() => {
    rmSync(BRAND_DIR, { recursive: true, force: true });
  });

  it('previews, then finalises: immutable version, money recomputed, files stored, audit with ids only', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const { p, res } = await previewAndFinalise(c, f, storage, f.quoteId);
      expect(p.preview.pageCount).toBe(2);
      expect(res.already).toBe(false);
      const d = (await c.query(`select status::text, total_pence, pdf_path, current_version_id from public.documents where id = $1`, [f.quoteId])).rows[0];
      expect(d).toMatchObject({ status: 'final', total_pence: '1008000', current_version_id: f.versionId });
      // Each finalise writes into its own folder under the version; the row records exactly where.
      expect(d.pdf_path).toMatch(new RegExp(`^${f.tenantId}/${f.customerId}/${f.jobId}/${f.versionId}/[0-9a-f-]{36}/document\\.pdf$`));
      expect((await storage.get(d.pdf_path))?.toString()).toContain('%PDF');
      expect(await storage.get(d.pdf_path.replace(/document\.pdf$/, 'page-02.png'))).not.toBeNull();
      expect(v_pdf(await c.query(`select final_content from public.document_versions where id = $1`, [f.versionId]))).toBe(d.pdf_path.replace(/\/document\.pdf$/, ''));
      const v = (await c.query(`select money, final_content, finalised_at from public.document_versions where id = $1`, [f.versionId])).rows[0];
      expect(v.finalised_at).not.toBeNull();
      expect(v.money).toMatchObject({ netPence: 840000, vatPence: 168000, grossPence: 1008000 });
      expect(v.money.schedule.map((i: { grossPence: number }) => i.grossPence)).toEqual([302400, 705600]);
      expect(v.final_content.pages).toBe(2);
      expect((await c.query(`select status::text from public.jobs where id = $1`, [f.jobId])).rows[0].status).toBe('quoted');
      const audit = (await c.query(`select action, entity_id, meta from public.audit_log where tenant_id = $1 and action like 'document.%' order by id`, [f.tenantId])).rows;
      expect(audit.map((a) => a.action)).toEqual(['document.confirm', 'document.finalise']);
      expect(audit[0]).toMatchObject({ entity_id: compactId(f.quoteId), meta: { version: compactId(f.versionId), pages: 2, wording: DEFAULT_CONFIRMATION.version } });
      expect(JSON.stringify(audit)).not.toMatch(/Smith|Bromley|BR2/);
      // The issued version can never change.
      await c.query('savepoint x');
      await expect(c.query(`update public.document_versions set input = '{}' where id = $1`, [f.versionId])).rejects.toThrow(/cannot be changed/);
      await c.query('rollback to savepoint x');
    });
  });

  it('a double submit returns the same result and writes nothing twice', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const { p } = await previewAndFinalise(c, f, storage, f.quoteId);
      const again = await finaliseWith(c, storage, actor(f), { documentId: f.quoteId, versionId: p.preview.versionId, key: p.preview.key, tokens: [], confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested);
      expect(again.already).toBe(true);
      expect((await c.query(`select count(*)::int n from public.audit_log where tenant_id = $1 and action = 'document.finalise'`, [f.tenantId])).rows[0].n).toBe(1);
    });
  });

  it('refuses without every page read, without the tick, or after the content changed; nothing is written', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const p = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p.ok) throw new Error('blocked');
      const base = { documentId: f.quoteId, versionId: p.preview.versionId, key: p.preview.key, confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version };
      await expectCode(finaliseWith(c, storage, actor(f), { ...base, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key, 1) }, { render, secret: SECRET }, nested), 'unread');
      await expectCode(finaliseWith(c, storage, actor(f), { ...base, confirmed: false, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key) }, { render, secret: SECRET }, nested), 'unconfirmed');
      await expectCode(finaliseWith(c, storage, actor(f), { ...base, confirmationVersion: 'old', tokens: tokens(f, f.quoteId, f.versionId, p.preview.key) }, { render, secret: SECRET }, nested), 'changed');
      // The owner edits the price after reading: the content key no longer matches.
      await c.query(`update public.document_versions set input = jsonb_set(input, '{form,price}', '"9000"') where id = $1`, [f.versionId]);
      await expectCode(finaliseWith(c, storage, actor(f), { ...base, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key) }, { render, secret: SECRET }, nested), 'changed');
      expect((await c.query(`select status::text from public.documents where id = $1`, [f.quoteId])).rows[0].status).toBe('draft');
      expect((await c.query(`select count(*)::int n from public.audit_log where tenant_id = $1 and action like 'document.%'`, [f.tenantId])).rows[0].n).toBe(0);
    });
  });

  it('another business cannot preview or finalise it', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const other = await createTenantWithUser(c, `Other ${randomBytes(4).toString('hex')}`);
      const storage = new InMemoryStorage();
      await expectCode(previewWith(c, storage, other, f.quoteId, { render, secret: SECRET }), 'not_found');
      await expectCode(finaliseWith(c, storage, other, { documentId: f.quoteId, versionId: f.versionId, key: 'k', tokens: [], confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested), 'not_found');
    });
  });

  it('junk tokens are refused before anything is drawn: the renderer is never called', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const p = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p.ok) throw new Error('blocked');
      let calls = 0;
      const spy: RenderFn = async (...args) => {
        calls += 1;
        return render(...args);
      };
      const base = { documentId: f.quoteId, versionId: f.versionId, key: p.preview.key, confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version };
      await expectCode(finaliseWith(c, storage, actor(f), { ...base, tokens: ['r1.1.' + 'a'.repeat(43), 'junk', 7] }, { render: spy, secret: SECRET }, nested), 'unread');
      // A key that was never previewed has no stored page count: read again, still nothing drawn.
      await expectCode(finaliseWith(c, storage, actor(f), { ...base, key: 'f'.repeat(32), tokens: [] }, { render: spy, secret: SECRET }, nested), 'changed');
      expect(calls).toBe(0);
    });
  });

  it('a version that changes while it is being drawn is refused, and the uploaded files are deleted again', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const p = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p.ok) throw new Error('blocked');
      const sneaky: RenderFn = async (...args) => {
        await c.query(`update public.document_versions set input = jsonb_set(input, '{form,price}', '"9000"') where id = $1`, [f.versionId]);
        return render(...args);
      };
      await expectCode(finaliseWith(c, storage, actor(f), { documentId: f.quoteId, versionId: f.versionId, key: p.preview.key, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render: sneaky, secret: SECRET }, nested), 'changed');
      const folder = `${f.tenantId}/${f.customerId}/${f.jobId}/${f.versionId}/`;
      expect(under(storage, folder).filter((k) => !k.includes('/preview-'))).toEqual([]);
      expect((await c.query(`select status::text from public.documents where id = $1`, [f.quoteId])).rows[0].status).toBe('draft');
    });
  });

  it('a lock timeout says someone else is finalising it, and cleans up its files', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const p = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p.ok) throw new Error('blocked');
      // Stand-in for another request holding the row: the locking select times out.
      const db = {
        query: (sql: string, params?: unknown[]) => {
          if (/for update of d/.test(sql)) return Promise.reject(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));
          return c.query(sql, params);
        },
      };
      const err = await finaliseWith(db, storage, actor(f), { documentId: f.quoteId, versionId: f.versionId, key: p.preview.key, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested).catch((e) => e);
      expect(err).toBeInstanceOf(DocumentError);
      expect(err.code).toBe('busy');
      expect(err.message).toMatch(/Someone else is finalising this document/);
      expect(under(storage, `${f.tenantId}/${f.customerId}/${f.jobId}/${f.versionId}/`).filter((k) => !k.includes('/preview-'))).toEqual([]);
    });
  });

  it('a lock timeout on the job row (taken first) also says someone else is busy, and cleans up its files', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const p = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p.ok) throw new Error('blocked');
      const seen: string[] = [];
      // Stand-in for a payment or follow-on save holding the job row: the job lock times out, before the document lock.
      const db = {
        query: (sql: string, params?: unknown[]) => {
          seen.push(sql);
          if (/from public\.jobs where id = \$1 and tenant_id = \$2 for update/.test(sql)) return Promise.reject(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));
          return c.query(sql, params);
        },
      };
      const err = await finaliseWith(db, storage, actor(f), { documentId: f.quoteId, versionId: f.versionId, key: p.preview.key, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested).catch((e) => e);
      expect(err).toBeInstanceOf(DocumentError);
      expect(err.code).toBe('busy');
      expect(err.message).toMatch(/Someone else is finalising this document/);
      expect(seen.some((q) => /for update of d/.test(q) && seen.indexOf(q) > seen.findIndex((x) => /from public\.jobs where id/.test(x)))).toBe(false);
      expect(under(storage, `${f.tenantId}/${f.customerId}/${f.jobId}/${f.versionId}/`).filter((k) => !k.includes('/preview-'))).toEqual([]);
      expect((await c.query(`select status::text from public.documents where id = $1`, [f.quoteId])).rows[0].status).toBe('draft');
    });
  });

  it('B uploads, A finishes first: B removes only its own files, A\'s row points at files that exist', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const p = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p.ok) throw new Error('blocked');
      const args = { documentId: f.quoteId, versionId: f.versionId, key: p.preview.key, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version };
      let aResult: Awaited<ReturnType<typeof finaliseWith>> | null = null;
      // B's render: while B is drawing (after its phase A checks), A runs to completion.
      const bRender: RenderFn = async (...r) => {
        aResult = await finaliseWith(c, storage, actor(f), args, { render, secret: SECRET }, nested);
        return { pdf: Buffer.from('%PDF-1.7 B bytes'), pngPages: [Buffer.from('B1'), Buffer.from('B2')] };
      };
      const b = await finaliseWith(c, storage, actor(f), args, { render: bRender, secret: SECRET }, nested);
      expect(aResult!.already).toBe(false);
      expect(b.already).toBe(true);
      const path = await pdfOf(c, f.quoteId);
      expect(path).toBe(aResult!.pdfPath);
      // A's files are intact and are A's bytes, never B's.
      expect((await storage.get(path!))?.toString()).toBe('%PDF-1.7 test');
      expect((await storage.get(path!.replace(/document\.pdf$/, 'page-01.png')))?.toString()).toBe('page one');
      expect([...storage.blobs.values()].some((x) => x.bytes.toString().startsWith('%PDF-1.7 B'))).toBe(false);
    });
  });

  it('an existing final document\'s files are never written again, and no upload ever overwrites', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const { p } = await previewAndFinalise(c, f, storage, f.quoteId);
      const writes: { path: string; overwrite: boolean }[] = [];
      const put = storage.put.bind(storage);
      storage.put = async (path, bytes, type, o = {}) => {
        writes.push({ path, overwrite: o.overwrite === true });
        return put(path, bytes, type, o);
      };
      const again = await finaliseWith(c, storage, actor(f), { documentId: f.quoteId, versionId: f.versionId, key: p.preview.key, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested);
      expect(again.already).toBe(true);
      expect(writes).toEqual([]);
      // And a fresh finalise of another version only ever writes new paths, never with overwrite.
      await reviseWith(c, actor(f), f.quoteId, nested);
      const p2 = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p2.ok) throw new Error('blocked');
      const v2 = p2.preview.versionId;
      writes.length = 0;
      await finaliseWith(c, storage, actor(f), { documentId: f.quoteId, versionId: v2, key: p2.preview.key, tokens: tokens(f, f.quoteId, v2, p2.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested);
      expect(writes.length).toBe(3);
      expect(writes.every((w) => !w.overwrite && w.path.includes(`/${v2}/`))).toBe(true);
    });
  });

  it('when the commit\'s outcome is unknown, nothing is deleted', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const p = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p.ok) throw new Error('blocked');
      const db = {
        query: (sql: string, params?: unknown[]) => (sql === 'release savepoint finalise_tx' ? Promise.reject(new Error('connection lost')) : c.query(sql, params)),
      };
      await expect(finaliseWith(db, storage, actor(f), { documentId: f.quoteId, versionId: f.versionId, key: p.preview.key, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested)).rejects.toThrow(/connection lost/);
      expect(storage.deleted).toEqual([]);
      expect(under(storage, `${f.tenantId}/${f.customerId}/${f.jobId}/${f.versionId}/`).filter((k) => k.endsWith('/document.pdf'))).toHaveLength(1);
    });
  });

  it('a change to the business details while the document is drawn is refused as changed', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const p = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p.ok) throw new Error('blocked');
      const sneaky: RenderFn = async (...r) => {
        await c.query(`update public.tenants set phone = '01234 999999' where id = $1`, [f.tenantId]);
        return render(...r);
      };
      await expectCode(finaliseWith(c, storage, actor(f), { documentId: f.quoteId, versionId: f.versionId, key: p.preview.key, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render: sneaky, secret: SECRET }, nested), 'changed');
    });
  });

  it('the confirmation audit records the person and their role', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      await previewAndFinalise(c, f, new InMemoryStorage(), f.quoteId);
      const a = (await c.query(`select user_id, meta from public.audit_log where tenant_id = $1 and action = 'document.confirm'`, [f.tenantId])).rows[0];
      expect(a.user_id).toBe(f.userId);
      expect(a.meta.role).toBe('owner');
    });
  });

  it('two finalises at the same moment: one does the work, the other finds it done (committed data, cleaned up after)', async () => {
    const setup = await connect();
    let f: Fx | null = null;
    try {
      f = await fixture(setup);
      const storage = new InMemoryStorage();
      const p = await previewWith(setup, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p.ok) throw new Error('blocked');
      const fx = f;
      const args = { documentId: fx.quoteId, versionId: fx.versionId, key: p.preview.key, tokens: tokens(fx, fx.quoteId, fx.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version };
      const one = await connect();
      const two = await connect();
      try {
        const results = await Promise.allSettled([
          finaliseWith(one, storage, actor(fx), args, { render, secret: SECRET }),
          finaliseWith(two, storage, actor(fx), args, { render, secret: SECRET }),
        ]);
        const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof finaliseWith>>> => r.status === 'fulfilled').map((r) => r.value);
        const bad = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason);
        // Exactly one did the work; the other returned it as already done or was refused cleanly.
        expect(ok.filter((r) => !r.already)).toHaveLength(1);
        for (const e of bad) expect(e).toBeInstanceOf(DocumentError);
        expect((await setup.query(`select count(*)::int n from public.audit_log where tenant_id = $1 and action = 'document.finalise'`, [fx.tenantId])).rows[0].n).toBe(1);
        // The final row points at files that exist, and only the winner's files are left.
        const path = await pdfOf(setup, fx.quoteId);
        expect(path && (await storage.get(path))).toBeTruthy();
        const left = under(storage, `${fx.tenantId}/${fx.customerId}/${fx.jobId}/${fx.versionId}/`).filter((k) => !k.includes('/preview-'));
        expect(left.every((k) => k.startsWith(path!.replace(/document\.pdf$/, '')))).toBe(true);
      } finally {
        await one.end();
        await two.end();
      }
    } finally {
      if (f) {
        // Clean up the committed business (audit rows are append only and hold ids only; they stay).
        await setup.query('begin');
        await setup.query(`select set_config('app.allow_final_delete', 'on', true)`);
        await setup.query(`delete from public.tenants where id = $1`, [f.tenantId]);
        await setup.query(`delete from auth.users where id = $1`, [f.userId]);
        await setup.query('commit');
      }
      await setup.end();
    }
  });

  it('a quote whose approval has no audit row cannot be finalised', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c, { audited: false });
      const storage = new InMemoryStorage();
      await expect(previewAndFinalise(c, f, storage, f.quoteId)).rejects.toSatisfy((e: unknown) => e instanceof DocumentError && e.code === 'missing');
    });
  });

  it('a storage failure rolls the finalise back', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      const p = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p.ok) throw new Error('blocked');
      storage.put = async () => {
        throw new Error('Storage upload failed');
      };
      await expect(finaliseWith(c, storage, actor(f), { documentId: f.quoteId, versionId: f.versionId, key: p.preview.key, tokens: tokens(f, f.quoteId, f.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested)).rejects.toThrow(/upload failed/);
      expect((await c.query(`select status::text from public.documents where id = $1`, [f.quoteId])).rows[0].status).toBe('draft');
      expect((await c.query(`select finalised_at from public.document_versions where id = $1`, [f.versionId])).rows[0].finalised_at).toBeNull();
    });
  });

  it('changing an issued quote makes a new version to read and tick again; the issued one stays', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      await previewAndFinalise(c, f, storage, f.quoteId);
      const r = await reviseWith(c, actor(f), f.quoteId, nested);
      expect(r.versionId).not.toBe(f.versionId);
      const d = (await c.query(`select status::text, current_version_id, pdf_path from public.documents where id = $1`, [f.quoteId])).rows[0];
      expect(d).toMatchObject({ status: 'draft', current_version_id: r.versionId, pdf_path: null });
      const versions = (await c.query(`select version, finalised_at is not null as issued from public.document_versions where document_id = $1 order by version`, [f.quoteId])).rows;
      expect(versions).toEqual([{ version: 1, issued: true }, { version: 2, issued: false }]);
      // Version 2 must be read again: the old tokens are for version 1.
      const p2 = await previewWith(c, storage, actor(f), f.quoteId, { render, secret: SECRET });
      if (!p2.ok) throw new Error('blocked');
      await expectCode(finaliseWith(c, storage, actor(f), { documentId: f.quoteId, versionId: r.versionId, key: p2.preview.key, tokens: tokens(f, f.quoteId, f.versionId, p2.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested), 'unread');
      const done = await finaliseWith(c, storage, actor(f), { documentId: f.quoteId, versionId: r.versionId, key: p2.preview.key, tokens: tokens(f, f.quoteId, r.versionId, p2.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested);
      expect(done.versionId).toBe(r.versionId);
    });
  });

  it('a deposit invoice goes through the same flow; its stored content holds no bank numbers', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      await previewAndFinalise(c, f, storage, f.quoteId);
      // The business changes its VAT setting after the quote was issued: the invoice stays at the issued rate.
      await c.query(`update public.tenant_defaults set vat_rate_bp = 0 where tenant_id = $1`, [f.tenantId]);
      const inv = await saveFollowOnWith(c, actor(f), { jobId: f.jobId, type: 'deposit-invoice', number: `INV-${f.reference}-D`, instalment: 1, heading: 'Deposit (30%)', netPence: 1, vatPence: 1, grossPence: 2, date: '2026-10-09', paymentId: null }, nested);
      const { res } = await previewAndFinalise(c, f, storage, inv.documentId);
      const v = (await c.query(`select money, final_content from public.document_versions where id = $1`, [res.versionId])).rows[0];
      // The draft's stored figures (1/1/2) are ignored: money comes from the schedule.
      expect(v.money).toMatchObject({ netPence: 252000, vatPence: 50400, grossPence: 302400, instalment: 1 });
      expect(JSON.stringify(v.final_content)).not.toMatch(/00000000|00-00-00/);
      // Revising the quote is now refused.
      await expectCode(reviseWith(c, actor(f), f.quoteId, nested), 'not_allowed');
    });
  });

  it('with no bank account an invoice is blocked; once the owner adds one in Settings it finalises with that account', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      await previewAndFinalise(c, f, storage, f.quoteId);
      // The business has no account at all now (the fixture's is archived, as Settings would).
      await c.query(`update public.bank_accounts set archived_at = now(), is_default = false where tenant_id = $1`, [f.tenantId]);
      const inv = await saveFollowOnWith(c, actor(f), { jobId: f.jobId, type: 'deposit-invoice', number: `INV-${f.reference}-D`, instalment: 1, heading: 'Deposit (30%)', netPence: 1, vatPence: 1, grossPence: 2, date: '2026-10-09', paymentId: null }, nested);
      const blocked = await previewWith(c, storage, actor(f), inv.documentId, { render, secret: SECRET });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.missing.join(' ')).toMatch(/No bank account is set up yet.*Settings/);
      const added = await addBankAccountWith(c, actor(f), { accountName: 'FJC Roofing Ltd', bankName: '', sortCode: '11-22-33', accountNumber: '87654321' }, Buffer.from(KEY, 'base64'), nested);
      expect(added.isDefault).toBe(true);
      let printed = '';
      const seeing: RenderFn = async (mapped, tenant, brand) => {
        printed = JSON.stringify(mapped);
        return render(mapped, tenant, brand);
      };
      const p = await previewWith(c, storage, actor(f), inv.documentId, { render: seeing, secret: SECRET });
      if (!p.ok) throw new Error(`blocked: ${p.missing.join('; ')}`);
      expect(printed).toContain('87654321');
      expect(printed).toContain('11-22-33');
      const res = await finaliseWith(c, storage, actor(f), { documentId: inv.documentId, versionId: p.preview.versionId, key: p.preview.key, tokens: tokens(f, inv.documentId, p.preview.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render: seeing, secret: SECRET }, nested);
      const v = (await c.query(`select bank_account_id, final_content from public.document_versions where id = $1`, [res.versionId])).rows[0];
      expect(v.bank_account_id).toBe(added.id);
      expect(JSON.stringify(v.final_content)).not.toMatch(/87654321|11-22-33/);
      expect(JSON.stringify(v.final_content)).toContain('4321');
    });
  });

  it('the owner\'s signature is printed only with consent on, and switching it changes what must be read again', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      let sig: string | null = 'unset';
      const seeing: RenderFn = async (mapped, tenant, brand) => {
        sig = brand.assets.signature;
        return render(mapped, tenant, brand);
      };
      const before = await previewWith(c, storage, actor(f), f.quoteId, { render: seeing, secret: SECRET });
      if (!before.ok) throw new Error('blocked');
      expect(sig).toBeNull();
      await saveSignatureWith(c, storage, actor(f), { png: Buffer.from('signature-png'), width: 300, height: 100 }, nested);
      const stillOff = await previewWith(c, storage, actor(f), f.quoteId, { render: seeing, secret: SECRET });
      if (!stillOff.ok) throw new Error('blocked');
      expect(stillOff.preview.key).toBe(before.preview.key);
      await setSignatureConsentWith(c, actor(f), true, nested);
      const on = await previewWith(c, storage, actor(f), f.quoteId, { render: seeing, secret: SECRET });
      if (!on.ok) throw new Error('blocked');
      expect(sig).toBe(`data:image/png;base64,${Buffer.from('signature-png').toString('base64')}`);
      expect(on.preview.key).not.toBe(before.preview.key);
      // Pages read with the signature off cannot be used to finalise with it on.
      await expectCode(finaliseWith(c, storage, actor(f), { documentId: f.quoteId, versionId: f.versionId, key: before.preview.key, tokens: tokens(f, f.quoteId, f.versionId, before.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render: seeing, secret: SECRET }, nested), 'changed');
    });
  });

  it('the retention purge deletes the customer folder with every page image (purge protocol, fake storage)', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      await previewAndFinalise(c, f, storage, f.quoteId);
      await c.query(`update public.customers set purge_at = now() - interval '1 day' where id = $1`, [f.customerId]);
      const n = await purgeExpiredWith(c, storage, nested);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(storage.deleted.some((p) => p.startsWith(`${f.tenantId}/${f.customerId}/${f.jobId}/${f.versionId}/`) && p.endsWith('/document.pdf'))).toBe(true);
      expect(storage.deletedPrefixes).toContain(`${f.tenantId}/${f.customerId}/`);
      expect([...storage.blobs.keys()].filter((k) => k.startsWith(`${f.tenantId}/${f.customerId}/`))).toEqual([]);
      expect((await c.query(`select count(*)::int n from public.customers where id = $1`, [f.customerId])).rows[0].n).toBe(0);
    });
  });
});
