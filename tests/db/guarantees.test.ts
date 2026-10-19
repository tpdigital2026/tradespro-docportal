import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { FJC_COLOURS } from '../../src/db/seed-fjc';
import { FJC_WORDING } from '../../src/db/wording';
import { sqlDate } from '../../src/db/sql-date';
import { guaranteeRows } from '../../src/lib/business/guarantees';
import { compactId } from '../../src/lib/data/customer-admin';
import { loadBusinessFactsSql } from '../../src/lib/data/business';
import { GuaranteeError, saveGuaranteeWith } from '../../src/lib/data/guarantees';
import { DEFAULT_CONFIRMATION } from '../../src/lib/documents/confirmation';
import { DocumentError, finaliseWith, previewWith, reviseWith, type RenderFn } from '../../src/lib/documents/finalise';
import { readToken } from '../../src/lib/documents/read-proof';
import { emptyGuarantee, type GuaranteeValues } from '../../src/lib/guarantee/model';
import { todayLondon } from '../../src/lib/london';
import { InMemoryStorage } from '../../src/lib/storage';
import { actAs, actAsServer, createTenantWithUser, dbAvailable, withRollback } from './helpers';

const SECRET = 's'.repeat(48);
const SLUG = `dbg${randomBytes(4).toString('hex')}`;
const BRAND_DIR = path.join(process.cwd(), 'public', 'brands', SLUG);
const nested = { nested: true } as const;
const today = todayLondon();

const render: RenderFn = async () => ({ pdf: Buffer.from('%PDF-1.7 test'), pngPages: [Buffer.from('page one')] });

interface Fx {
  tenantId: string;
  userId: string;
  customerId: string;
  jobId: string;
  reference: string;
}

const values = (over: Partial<GuaranteeValues> = {}): GuaranteeValues => emptyGuarantee({ roofType: 'tiled', years: '25', address: '5 Sample Road, Anytown', completedOn: '2026-01-05', ...over });

async function fixture(c: Client, o: { wording?: boolean; brand?: boolean } = {}): Promise<Fx> {
  const t = await createTenantWithUser(c, `Gua ${randomBytes(4).toString('hex')}`);
  await c.query(`update public.tenants set slug = $2::text, address_lines = '{Rochester,ME3 9UD}', phone = '01234 000000', email = 'office@example.test', website = 'www.example.test', company_number = '00000000', tagline = 'Tag' where id = $1`, [t.tenantId, o.brand === false ? null : SLUG]);
  await c.query(`insert into public.tenant_defaults (tenant_id, terms) values ($1, $2)`, [t.tenantId, JSON.stringify(o.wording === false ? {} : FJC_WORDING)]);
  const kit = await c.query(`insert into public.brand_kits (tenant_id, colours) values ($1, $2) returning id`, [t.tenantId, JSON.stringify(FJC_COLOURS)]);
  for (const [kind, file] of [['logo_colour', 'logo.png'], ['logo_white', 'logo_white.png']]) {
    await c.query(`insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, $3, $4)`, [t.tenantId, kit.rows[0].id, kind, `${t.tenantId}/${file}`]);
  }
  const cust = await c.query(`insert into public.customers (tenant_id, name, address_lines, postcode) values ($1, 'Mr John Smith', '{123 Bromley Road}', 'BR2 8BG') returning id`, [t.tenantId]);
  const reference = `G-${randomBytes(3).toString('hex').toUpperCase()}`;
  const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference, property_address) values ($1, $2, $3, '123 Bromley Road, BR2 8BG') returning id`, [t.tenantId, cust.rows[0].id, reference]);
  return { ...t, customerId: cust.rows[0].id, jobId: job.rows[0].id, reference };
}

const actor = (f: Fx) => ({ tenantId: f.tenantId, userId: f.userId, role: 'owner' });
const make = (c: Client, f: Fx, v: GuaranteeValues = values(), job = f.jobId) => saveGuaranteeWith(c, actor(f), { documentId: null, job: { kind: 'existing', id: job }, values: v }, today, nested);
const tokens = (f: Fx, documentId: string, versionId: string, key: string, pages = 1) => Array.from({ length: pages }, (_, i) => readToken(SECRET, { tenantId: f.tenantId, userId: f.userId, documentId, versionId, key }, i + 1));

async function previewAndFinalise(c: Client, f: Fx, storage: InMemoryStorage, documentId: string) {
  const p = await previewWith(c, storage, actor(f), documentId, { render, secret: SECRET });
  if (!p.ok) throw new Error(`preview blocked: ${p.missing.join('; ')}`);
  const res = await finaliseWith(c, storage, actor(f), { documentId, versionId: p.preview.versionId, key: p.preview.key, tokens: tokens(f, documentId, p.preview.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested);
  return { p, res };
}

async function expectFail(c: Client, sql: string, params: unknown[], re: RegExp) {
  await c.query('savepoint ef');
  await expect(c.query(sql, params)).rejects.toThrow(re);
  await c.query('rollback to savepoint ef');
}

describe.skipIf(!dbAvailable)('guarantee certificates', () => {
  beforeAll(() => {
    mkdirSync(BRAND_DIR, { recursive: true });
    copyFileSync(path.join(process.cwd(), 'public', 'brands', 'fjc', 'logo.png'), path.join(BRAND_DIR, 'logo.png'));
    copyFileSync(path.join(process.cwd(), 'public', 'brands', 'fjc', 'logo_white.png'), path.join(BRAND_DIR, 'logo_white.png'));
  });
  afterAll(() => {
    rmSync(BRAND_DIR, { recursive: true, force: true });
  });

  describe('numbers', () => {
    it('are GC-{job} first, then GC-{job}-G2 to -G20, and nothing else', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const ins = `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'guarantee', $3)`;
        for (const n of [`GC-${f.reference}`, `GC-${f.reference}-G2`, `GC-${f.reference}-G9`, `GC-${f.reference}-G10`, `GC-${f.reference}-G20`]) await c.query(ins, [f.tenantId, f.jobId, n]);
        for (const bad of [`GC-${f.reference}-G1`, `GC-${f.reference}-G21`, `GC-${f.reference}-G02`, `GC-${f.reference}-2`, `GC-${f.reference}-G`, `GC-OTHER-1`, `GUA-${f.reference}`, f.reference, `GC-${f.reference}x`]) {
          await expectFail(c, ins, [f.tenantId, f.jobId, bad], /does not match its job and document type/);
        }
      });
    });

    it('make a job reference that ends in -G and a number impossible, so two jobs can never share a certificate number', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        for (const ref of ['Q-5-G2', 'Q-5-G20', 'ABC-G1']) await expectFail(c, `insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3)`, [f.tenantId, f.customerId, ref], /jobs_reference_not_document_like/);
        for (const ref of ['Q-5-G', 'Q-5-Gx', 'Q-5-2']) await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3)`, [f.tenantId, f.customerId, ref]);
        expect((await c.query(`select convalidated from pg_constraint where conname = 'jobs_reference_not_document_like'`)).rows).toEqual([{ convalidated: true }]);
      });
    });

    it('are claimed forever, like every other document number', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const a = await make(c, f);
        expect(a.number).toBe(`GC-${f.reference}`);
        await c.query(`delete from public.documents where id = $1`, [a.documentId]);
        await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'guarantee', $3)`, [f.tenantId, f.jobId, a.number], /already been used/);
        // The next certificate made takes the next free place, not the one burnt.
        const b = await make(c, f);
        expect(b.number).toBe(`GC-${f.reference}-G2`);
      });
    });
  });

  describe('one certificate per roof type', () => {
    it('lets a job have one for each roof and refuses a second for the same roof', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const tiled = await make(c, f);
        const flat = await make(c, f, values({ roofType: 'flat', years: '20' }));
        expect([tiled.number, flat.number]).toEqual([`GC-${f.reference}`, `GC-${f.reference}-G2`]);
        const err = await make(c, f, values({ years: '10' })).catch((e) => e);
        expect(err).toBeInstanceOf(GuaranteeError);
        expect((err as GuaranteeError).code).toBe('exists');
        expect((err as GuaranteeError).existingId).toBe(tiled.documentId);
        // Another roof in words: its own roof, once.
        await make(c, f, values({ roofType: 'other', roofOther: 'Garage roof' }));
        const again = await make(c, f, values({ roofType: 'other', roofOther: ' garage  ROOF. ' })).catch((e) => e);
        expect((again as GuaranteeError).code).toBe('exists');
      });
    });

    it('is enforced by the database itself, for an insert and for an edit', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const a = await make(c, f);
        const b = await make(c, f, values({ roofType: 'flat', years: '20' }));
        const dup = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'guarantee', $3) returning id`, [f.tenantId, f.jobId, `GC-${f.reference}-G3`]);
        const stored = JSON.stringify({ schema: 1, guarantee: { ...values(), roofKey: 'tiled' } });
        await expectFail(c, `insert into public.document_versions (tenant_id, document_id, version, input) values ($1, $2, 1, $3::jsonb)`, [f.tenantId, dup.rows[0].id, stored], /already has a guarantee certificate for that roof type/);
        await expectFail(c, `update public.document_versions set input = $2::jsonb where document_id = $1`, [b.documentId, stored], /already has a guarantee certificate for that roof type/);
        // Another job of the same business, and a draft that is its own roof, are fine.
        const job2 = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`, [f.tenantId, f.customerId, `${f.reference}-2`]);
        await make(c, f, values(), job2.rows[0].id);
        expect(a.number).toBe(`GC-${f.reference}`);
      });
    });

    it('does not count a void certificate, and another business is never in the way', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const other = await fixture(c, { brand: false });
        const a = await make(c, f);
        await make(c, other);
        await c.query(`update public.documents set status = 'void' where id = $1`, [a.documentId]);
        const again = await make(c, f);
        expect(again.number).toBe(`GC-${f.reference}-G2`);
      });
    });

    it('a certificate cannot be moved onto another job or business by a crafted request', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const other = await fixture(c, { brand: false });
        const err = await saveGuaranteeWith(c, actor(f), { documentId: null, job: { kind: 'existing', id: other.jobId }, values: values() }, today, nested).catch((e) => e);
        expect((err as GuaranteeError).code).toBe('invalid');
        const mine = await make(c, f);
        const hijack = await saveGuaranteeWith(c, actor(other), { documentId: mine.documentId, job: null, values: values({ years: '5' }) }, today, nested).catch((e) => e);
        expect((hijack as GuaranteeError).code).toBe('not_found');
        const stored = await c.query(`select input -> 'guarantee' ->> 'years' as y from public.document_versions where document_id = $1`, [mine.documentId]);
        expect(stored.rows[0].y).toBe('25');
      });
    });
  });

  describe('row level security', () => {
    it('shows a certificate and its versions to its own business only', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const other = await fixture(c, { brand: false });
        const a = await make(c, f);
        await actAs(c, f.userId);
        expect((await c.query(`select count(*)::int n from public.documents where type = 'guarantee'`)).rows[0].n).toBe(1);
        expect((await c.query(`select count(*)::int n from public.document_versions where document_id = $1`, [a.documentId])).rows[0].n).toBe(1);
        await actAsServer(c);
        await actAs(c, other.userId);
        expect((await c.query(`select count(*)::int n from public.documents where id = $1`, [a.documentId])).rows[0].n).toBe(0);
        expect((await c.query(`select count(*)::int n from public.document_versions where document_id = $1`, [a.documentId])).rows[0].n).toBe(0);
        expect((await c.query(`select count(*)::int n from public.documents where type = 'guarantee'`)).rows[0].n).toBe(0);
        // The app role cannot write one either: certificates are made by the server.
        await c.query('savepoint w');
        await expect(c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'guarantee', $3)`, [other.tenantId, f.jobId, `GC-${f.reference}-G2`])).rejects.toThrow();
        await c.query('rollback to savepoint w');
      });
    });
  });

  describe('preview and finalise', () => {
    it('issues the certificate: files stored, issue date set to today, audit with ids only, listed on the Guarantees tab', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const draft = await make(c, f);
        // A draft left over from an earlier day: the date it is issued is the day it is finalised.
        await c.query(`update public.documents set doc_date = '2026-01-01' where id = $1`, [draft.documentId]);
        const storage = new InMemoryStorage();
        const { p, res } = await previewAndFinalise(c, f, storage, draft.documentId);
        expect(p.preview.pageCount).toBe(1);
        expect(res.already).toBe(false);
        const d = (await c.query(`select status::text, total_pence, pdf_path, doc_date from public.documents where id = $1`, [draft.documentId])).rows[0];
        expect(d.status).toBe('final');
        expect(d.total_pence).toBeNull();
        expect(sqlDate(d.doc_date)).toBe(today);
        expect((await storage.get(d.pdf_path))?.toString()).toContain('%PDF');
        const v = (await c.query(`select final_content from public.document_versions where document_id = $1`, [draft.documentId])).rows[0].final_content;
        expect(v.content).toMatchObject({ kind: 'guarantee', input: { certificateNo: draft.number, years: 25, workDescription: 'tiled roof', completedLabel: '05/01/2026' } });
        const audit = (await c.query(`select action, entity_id, meta from public.audit_log where tenant_id = $1 and (action like 'document.%' or action like 'guarantee.%') order by id`, [f.tenantId])).rows;
        expect(audit.map((a) => a.action)).toEqual(['guarantee.create', 'document.confirm', 'document.finalise']);
        expect(audit.every((a) => a.entity_id === compactId(draft.documentId))).toBe(true);
        expect(JSON.stringify(audit)).not.toMatch(/Smith|Bromley|Sample Road|BR2/);
        const rows = guaranteeRows((await loadBusinessFactsSql(c, f.tenantId)).jobs);
        expect(rows).toEqual([expect.objectContaining({ certificateNo: draft.number, years: 25, issuedOn: today, expiryYear: Number(today.slice(0, 4)) + 25 })]);
      });
    });

    it('is locked once issued: no edits, no new version, and a double submit changes nothing', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const draft = await make(c, f);
        const storage = new InMemoryStorage();
        const { p } = await previewAndFinalise(c, f, storage, draft.documentId);
        const edit = await saveGuaranteeWith(c, actor(f), { documentId: draft.documentId, job: null, values: values({ years: '5' }) }, today, nested).catch((e) => e);
        expect((edit as GuaranteeError).code).toBe('locked');
        await expect(reviseWith(c, actor(f), draft.documentId, nested)).rejects.toSatisfy((e: unknown) => e instanceof DocumentError && e.code === 'not_allowed');
        const again = await finaliseWith(c, storage, actor(f), { documentId: draft.documentId, versionId: p.preview.versionId, key: p.preview.key, tokens: [], confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested);
        expect(again.already).toBe(true);
        expect((await c.query(`select count(*)::int n from public.audit_log where tenant_id = $1 and action = 'document.finalise'`, [f.tenantId])).rows[0].n).toBe(1);
        await expectFail(c, `update public.document_versions set input = '{}' where document_id = $1`, [draft.documentId], /cannot be changed/);
      });
    });

    it('refuses to preview or issue until every fact is on record, and never with a completion date in the future', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const draft = await make(c, f, values({ years: '', completedOn: '' }));
        const storage = new InMemoryStorage();
        const blocked = await previewWith(c, storage, actor(f), draft.documentId, { render, secret: SECRET });
        expect(blocked.ok).toBe(false);
        if (!blocked.ok) expect(blocked.missing.join(' ')).toMatch(/how many years[\s\S]*date the installation was completed/);
        // A date that was fine when typed can still not be issued if it is in the future now (written straight to the draft).
        await c.query(`update public.document_versions set input = jsonb_set(input, '{guarantee,completedOn}', '"2999-01-01"'::jsonb, true) where document_id = $1`, [draft.documentId]);
        await c.query(`update public.document_versions set input = jsonb_set(input, '{guarantee,years}', '"25"'::jsonb, true) where document_id = $1`, [draft.documentId]);
        const future = await previewWith(c, storage, actor(f), draft.documentId, { render, secret: SECRET });
        expect(future.ok).toBe(false);
        if (!future.ok) expect(future.missing.join(' ')).toMatch(/future/);
      });
    });

    it('needs the business’s own guarantee wording, and never makes any up', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c, { wording: false });
        const draft = await make(c, f);
        const r = await previewWith(c, new InMemoryStorage(), actor(f), draft.documentId, { render, secret: SECRET });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.missing.join(' ')).toMatch(/guarantee wording is not set up/);
      });
    });

    it('will not issue a certificate that was read by another person or edited after it was read', async () => {
      await withRollback(async (c) => {
        const f = await fixture(c);
        const draft = await make(c, f);
        const storage = new InMemoryStorage();
        const p = await previewWith(c, storage, actor(f), draft.documentId, { render, secret: SECRET });
        if (!p.ok) throw new Error('blocked');
        await saveGuaranteeWith(c, actor(f), { documentId: draft.documentId, job: null, values: values({ address: '9 Another Road, Anytown' }) }, today, nested);
        const args = { documentId: draft.documentId, versionId: p.preview.versionId, key: p.preview.key, tokens: tokens(f, draft.documentId, p.preview.versionId, p.preview.key), confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version };
        await expect(finaliseWith(c, storage, actor(f), args, { render, secret: SECRET }, nested)).rejects.toSatisfy((e: unknown) => e instanceof DocumentError && e.code === 'changed');
        await expect(finaliseWith(c, storage, actor(f), { ...args, tokens: [] }, { render, secret: SECRET }, nested)).rejects.toBeInstanceOf(DocumentError);
      });
    });
  });
});
