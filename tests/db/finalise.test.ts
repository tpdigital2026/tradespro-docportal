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
import { encryptBankDetails } from '../../src/security/bank-crypto';
import type { QuoteFormValues } from '../../src/lib/validation/quote';
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

const actor = (f: Fx) => ({ tenantId: f.tenantId, userId: f.userId });
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
      expect(d.pdf_path).toBe(`${f.tenantId}/${f.customerId}/${f.jobId}/${f.versionId}/document.pdf`);
      expect((await storage.get(d.pdf_path))?.toString()).toContain('%PDF');
      expect(await storage.get(`${f.tenantId}/${f.customerId}/${f.jobId}/${f.versionId}/page-02.png`)).not.toBeNull();
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

  it('erasing the customer deletes the folder with every page image (purge protocol, fake storage)', async () => {
    await withRollback(async (c) => {
      const f = await fixture(c);
      const storage = new InMemoryStorage();
      await previewAndFinalise(c, f, storage, f.quoteId);
      await c.query(`update public.customers set purge_at = now() - interval '1 day' where id = $1`, [f.customerId]);
      const n = await purgeExpiredWith(c, storage, nested);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(storage.deleted).toContain(`${f.tenantId}/${f.customerId}/${f.jobId}/${f.versionId}/document.pdf`);
      expect(storage.deletedPrefixes).toContain(`${f.tenantId}/${f.customerId}/`);
      expect([...storage.blobs.keys()].filter((k) => k.startsWith(`${f.tenantId}/${f.customerId}/`))).toEqual([]);
      expect((await c.query(`select count(*)::int n from public.customers where id = $1`, [f.customerId])).rows[0].n).toBe(0);
    });
  });
});
