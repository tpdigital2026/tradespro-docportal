import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { FJC_COLOURS } from '../../src/db/seed-fjc';
import { FJC_WORDING } from '../../src/db/wording';
import { approveSurveyPartWith, deleteSurveyPhotoWith, readSurveyPhotoWith, saveSurveyWith, SurveyError, uploadSurveyPhotoWith } from '../../src/lib/data/surveys';
import { DEFAULT_CONFIRMATION } from '../../src/lib/documents/confirmation';
import { DocumentError, finaliseWith, previewWith, type RenderFn } from '../../src/lib/documents/finalise';
import { readToken } from '../../src/lib/documents/read-proof';
import { emptyFinding, emptySurvey, findingHash, opinionHash, type SurveyFormValues } from '../../src/lib/survey/model';
import { InMemoryStorage } from '../../src/lib/storage';
import { placeholderPhoto } from '../fixtures/survey';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

const SECRET = 's'.repeat(48);
const SLUG = `dbs${randomBytes(4).toString('hex')}`;
const BRAND_DIR = path.join(process.cwd(), 'public', 'brands', SLUG);
const nested = { nested: true } as const;
const render: RenderFn = async () => ({ pdf: Buffer.from('%PDF-1.7 test'), pngPages: [Buffer.from('p1'), Buffer.from('p2')] });

interface Fx {
  tenantId: string;
  userId: string;
}

async function business(c: Client, branded = true): Promise<Fx> {
  const t = await createTenantWithUser(c, `Survey ${randomBytes(4).toString('hex')}`);
  if (branded) await c.query(`update public.tenants set slug = $2, tagline = 'Tag' where id = $1`, [t.tenantId, SLUG]);
  await c.query(`insert into public.tenant_defaults (tenant_id, terms) values ($1, $2)`, [t.tenantId, JSON.stringify(FJC_WORDING)]);
  const kit = await c.query(`insert into public.brand_kits (tenant_id, colours) values ($1, $2) returning id`, [t.tenantId, JSON.stringify(FJC_COLOURS)]);
  for (const [kind, file] of [['logo_colour', 'logo.png'], ['logo_white', 'logo_white.png']]) {
    await c.query(`insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, $3, $4)`, [t.tenantId, kit.rows[0].id, kind, `${t.tenantId}/${file}`]);
  }
  return t;
}

const newCustomer = { kind: 'new' as const, customer: { name: 'Mr John Smith', addressLines: ['123 Bromley Road'], postcode: 'BR1 1AA', email: '', phone: '' } };
const values = (over: Partial<SurveyFormValues> = {}): SurveyFormValues => ({ ...emptySurvey({ surveyDate: '2026-10-14', preparedBy: 'Test Owner', propertyAddress: '123 Bromley Road, BR1 1AA' }), ...over });
const ref = () => `S-${randomBytes(3).toString('hex').toUpperCase()}`;

/** A survey with one complete finding (one photo) and a written opinion, nothing approved yet. */
async function readySurvey(c: Client, f: Fx, storage: InMemoryStorage) {
  const first = await saveSurveyWith(c, f, { documentId: null, customer: newCustomer, job: { kind: 'new', reference: ref() }, values: values() }, '2026-10-14', nested);
  const photo = await uploadSurveyPhotoWith(c, storage, f, first.documentId, await placeholderPhoto(1, 800, 600), nested);
  const finding = { ...emptyFinding('f-abcdef1234'), photoIds: [photo.id], ownerLine: 'gutter blocked', title: 'Gutter blocked', observation: 'The gutter is blocked.', assessment: 'In my assessment it needs clearing.' };
  const v = values({ findings: [finding], coverPhotoId: photo.id, opinion: 'It is my professional opinion that the gutter needs clearing.', signName: 'Test Owner' });
  const saved = await saveSurveyWith(c, f, { documentId: first.documentId, customer: null, job: null, values: v }, '2026-10-14', nested);
  return { ...saved, photo, v };
}

describe.skipIf(!dbAvailable)('survey reports', () => {
  beforeAll(() => {
    mkdirSync(BRAND_DIR, { recursive: true });
    copyFileSync(path.join(process.cwd(), 'public', 'brands', 'fjc', 'logo.png'), path.join(BRAND_DIR, 'logo.png'));
    copyFileSync(path.join(process.cwd(), 'public', 'brands', 'fjc', 'logo_white.png'), path.join(BRAND_DIR, 'logo_white.png'));
  });
  afterAll(() => rmSync(BRAND_DIR, { recursive: true, force: true }));

  it('the first save creates the customer, the job and the report SR-{job} with version 1, all in this business', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const r = ref();
      const s = await saveSurveyWith(c, f, { documentId: null, customer: newCustomer, job: { kind: 'new', reference: r }, values: values() }, '2026-10-14', nested);
      expect(s.number).toBe(`SR-${r}`);
      const cust = await c.query(`select tenant_id, name from public.customers where id = $1`, [s.customerId]);
      expect(cust.rows[0]).toMatchObject({ tenant_id: f.tenantId, name: 'Mr John Smith' });
      const job = await c.query(`select reference, customer_id, property_address from public.jobs where id = $1`, [s.jobId]);
      expect(job.rows[0]).toMatchObject({ reference: r, customer_id: s.customerId, property_address: '123 Bromley Road, BR1 1AA' });
      const doc = await c.query(`select type::text, number, status::text, current_version_id from public.documents where id = $1`, [s.documentId]);
      expect(doc.rows[0]).toMatchObject({ type: 'survey_report', number: `SR-${r}`, status: 'draft' });
      const used = await c.query(`select 1 from public.used_numbers where tenant_id = $1 and number = $2`, [f.tenantId, `SR-${r}`]);
      expect(used.rowCount).toBe(1);
      // A job number already used is refused and nothing is left behind.
      await expect(saveSurveyWith(c, f, { documentId: null, customer: newCustomer, job: { kind: 'new', reference: r }, values: values() }, '2026-10-14', nested)).rejects.toSatisfy((e: unknown) => e instanceof SurveyError && e.code === 'number_used');
      const n = await c.query(`select count(*)::int as n from public.customers where tenant_id = $1`, [f.tenantId]);
      expect(n.rows[0].n).toBe(1);
    });
  });

  it('the database refuses a survey number that does not match its job', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const s = await saveSurveyWith(c, f, { documentId: null, customer: newCustomer, job: { kind: 'new', reference: ref() }, values: values() }, '2026-10-14', nested);
      const job2 = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`, [f.tenantId, s.customerId, ref()]);
      await expect(c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'survey_report', 'SR-SOMETHING-ELSE')`, [f.tenantId, job2.rows[0].id])).rejects.toThrow(/survey number does not match/);
    });
  });

  it('a survey can attach to an existing job of the same customer, never to another business or customer', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const other = await business(c, false);
      const cust = await c.query(`insert into public.customers (tenant_id, name, address_lines, postcode) values ($1, 'Mr John Smith', '{123 Bromley Road}', 'BR1 1AA') returning id`, [f.tenantId]);
      const r = ref();
      const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`, [f.tenantId, cust.rows[0].id, r]);
      const s = await saveSurveyWith(c, f, { documentId: null, customer: { kind: 'existing', id: cust.rows[0].id }, job: { kind: 'existing', id: job.rows[0].id }, values: values() }, '2026-10-14', nested);
      expect(s.number).toBe(`SR-${r}`);
      await expect(saveSurveyWith(c, other, { documentId: null, customer: { kind: 'existing', id: cust.rows[0].id }, job: { kind: 'existing', id: job.rows[0].id }, values: values() }, '2026-10-14', nested)).rejects.toBeInstanceOf(SurveyError);
      await expect(saveSurveyWith(c, f, { documentId: null, customer: newCustomer, job: { kind: 'existing', id: job.rows[0].id }, values: values() }, '2026-10-14', nested)).rejects.toThrow(/different customer/);
    });
  });

  it('photos: row first, then the file; numbers live in the form; another business cannot read or use them; delete removes both', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const other = await business(c, false);
      const storage = new InMemoryStorage();
      const s = await saveSurveyWith(c, f, { documentId: null, customer: newCustomer, job: { kind: 'new', reference: ref() }, values: values() }, '2026-10-14', nested);
      const photo = await uploadSurveyPhotoWith(c, storage, f, s.documentId, await placeholderPhoto(0, 2600, 1300), nested);
      expect(photo.width).toBe(2000);
      const row = await c.query(`select storage_path, sha256, bytes, job_id from public.job_photos where id = $1`, [photo.id]);
      expect(row.rows[0].storage_path).toBe(`${f.tenantId}/${s.customerId}/${s.jobId}/${photo.id}.jpg`);
      expect(row.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(storage.objects.has(row.rows[0].storage_path)).toBe(true);
      expect(await readSurveyPhotoWith(c, storage, f.tenantId, photo.id)).not.toBeNull();
      expect(await readSurveyPhotoWith(c, storage, other.tenantId, photo.id)).toBeNull();
      // A crafted save naming a photo of another job keeps only the job's own photos.
      const foreign = randomUUID();
      const saved = await saveSurveyWith(c, f, { documentId: s.documentId, customer: null, job: null, values: values({ findings: [{ ...emptyFinding('f-zzzzzz1234'), photoIds: [photo.id, foreign] }] }) }, '2026-10-14', nested);
      expect(saved.values.findings[0].photoIds).toEqual([photo.id]);
      await expect(uploadSurveyPhotoWith(c, storage, other, s.documentId, await placeholderPhoto(1), nested)).rejects.toSatisfy((e: unknown) => e instanceof SurveyError && e.code === 'not_found');
      await deleteSurveyPhotoWith(c, storage, f, s.documentId, photo.id, nested);
      expect((await c.query(`select 1 from public.job_photos where id = $1`, [photo.id])).rowCount).toBe(0);
      expect(storage.objects.has(row.rows[0].storage_path)).toBe(false);
    });
  });

  it('a failed upload deletes the row again, and a non-image never reaches the database', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const storage = new InMemoryStorage();
      storage.put = async () => {
        throw new Error('down');
      };
      const s = await saveSurveyWith(c, f, { documentId: null, customer: newCustomer, job: { kind: 'new', reference: ref() }, values: values() }, '2026-10-14', nested);
      await expect(uploadSurveyPhotoWith(c, storage, f, s.documentId, await placeholderPhoto(0, 800, 600), nested)).rejects.toThrow(/could not be stored/);
      expect((await c.query(`select count(*)::int as n from public.job_photos where job_id = $1`, [s.jobId])).rows[0].n).toBe(0);
      await expect(uploadSurveyPhotoWith(c, new InMemoryStorage(), f, s.documentId, Buffer.from('%PDF-1.4 not a photo'), nested)).rejects.toThrow(/not a photo/);
      expect((await c.query(`select count(*)::int as n from public.job_photos where job_id = $1`, [s.jobId])).rows[0].n).toBe(0);
    });
  });

  it('approvals: only the server makes them, with an audit row (ids and the fingerprint); a crafted approval in a save is dropped; an edit clears it', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const storage = new InMemoryStorage();
      const s = await readySurvey(c, f, storage);
      const fx = s.v.findings[0];
      // Crafted: the browser claims an approval with a correct fingerprint. It is not kept.
      const crafted = await saveSurveyWith(c, f, { documentId: s.documentId, customer: null, job: null, values: { ...s.v, findings: [{ ...fx, approvedAt: '2026-10-14T09:00:00Z', approvalHash: findingHash(fx) }], opinionApprovedAt: 'x', opinionHash: 'hx' } }, '2026-10-14', nested);
      expect(crafted.values.findings[0].approvalHash).toBeNull();
      expect(crafted.values.opinionHash).toBeNull();

      const a = await approveSurveyPartWith(c, f, s.documentId, s.v, { kind: 'finding', findingId: fx.id }, nested);
      expect(a.values.findings[0].approvalHash).toBe(findingHash(fx));
      const audit = await c.query(`select entity, entity_id, meta from public.audit_log where tenant_id = $1 and action = 'survey.approve'`, [f.tenantId]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].entity_id).toBe(s.documentId.replace(/-/g, ''));
      expect(audit.rows[0].meta).toMatchObject({ part: 'finding', n: 1, hash: findingHash(fx) });
      expect(JSON.stringify(audit.rows[0].meta)).not.toMatch(/gutter|Smith|Bromley/i);
      // The same content saved again keeps the approval; a changed word clears it.
      const kept = await saveSurveyWith(c, f, { documentId: s.documentId, customer: null, job: null, values: a.values }, '2026-10-14', nested);
      expect(kept.values.findings[0].approvalHash).toBe(findingHash(fx));
      const edited = await saveSurveyWith(c, f, { documentId: s.documentId, customer: null, job: null, values: { ...a.values, findings: [{ ...a.values.findings[0], assessment: 'Changed.' }] } }, '2026-10-14', nested);
      expect(edited.values.findings[0].approvalHash).toBeNull();
      // An incomplete finding cannot be approved.
      await expect(approveSurveyPartWith(c, f, s.documentId, { ...s.v, findings: [{ ...fx, assessment: '' }] }, { kind: 'finding', findingId: fx.id }, nested)).rejects.toThrow(/assessment/);
    });
  });

  it('finalise refuses until every finding and the opinion are approved and audited, then issues the report through the same flow', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const storage = new InMemoryStorage();
      const s = await readySurvey(c, f, storage);
      const blocked = await previewWith(c, storage, f, s.documentId, { render, secret: SECRET });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.missing.join(' ')).toMatch(/Finding 1 has not been approved/);

      const a1 = await approveSurveyPartWith(c, f, s.documentId, s.v, { kind: 'finding', findingId: s.v.findings[0].id }, nested);
      // An approval written straight into the draft, with no audit row behind it, does not count.
      const forged = { ...a1.values, opinionApprovedAt: '2026-10-14T09:00:00.000Z', opinionHash: opinionHash(a1.values) };
      await c.query(`update public.document_versions set input = $1::jsonb where document_id = $2`, [JSON.stringify({ schema: 1, survey: forged }), s.documentId]);
      const p = await previewWith(c, storage, f, s.documentId, { render, secret: SECRET });
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      const tokens = [1, 2].map((n) => readToken(SECRET, { tenantId: f.tenantId, userId: f.userId, documentId: s.documentId, versionId: p.preview.versionId, key: p.preview.key }, n));
      const args = { documentId: s.documentId, versionId: p.preview.versionId, key: p.preview.key, tokens, confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version };
      await expect(finaliseWith(c, storage, f, args, { render, secret: SECRET }, nested)).rejects.toSatisfy((e: unknown) => e instanceof DocumentError && e.code === 'missing' && e.missing.some((m) => /opinion/.test(m)));

      const a2 = await approveSurveyPartWith(c, f, s.documentId, a1.values, { kind: 'opinion' }, nested);
      expect(a2.values.opinionHash).toMatch(/^h[0-9a-f]{64}$/);
      const res = await finaliseWith(c, storage, f, args, { render, secret: SECRET }, nested);
      expect(res.already).toBe(false);
      const doc = await c.query(`select status::text, total_pence, pdf_path from public.documents where id = $1`, [s.documentId]);
      expect(doc.rows[0]).toMatchObject({ status: 'final', total_pence: null });
      const ver = await c.query(`select final_content from public.document_versions where id = $1`, [p.preview.versionId]);
      expect(ver.rows[0].final_content.content.kind).toBe('survey');
      // No photo bytes are kept in the record: references only.
      expect(JSON.stringify(ver.rows[0].final_content)).not.toMatch(/base64/);
      // Issued: no more edits, no more photos, and its photo cannot be deleted.
      await expect(saveSurveyWith(c, f, { documentId: s.documentId, customer: null, job: null, values: a2.values }, '2026-10-14', nested)).rejects.toSatisfy((e: unknown) => e instanceof SurveyError && e.code === 'locked');
      await expect(deleteSurveyPhotoWith(c, storage, f, s.documentId, s.photo.id, nested)).rejects.toBeInstanceOf(SurveyError);
      // The photo belongs to the customer: erasure lists it.
      const paths = await c.query(`select private.customer_storage_paths($1, $2) as p`, [f.tenantId, s.customerId]);
      expect(paths.rows.map((r) => String(r.p))).toContain(`${f.tenantId}/${s.customerId}/${s.jobId}/${s.photo.id}.jpg`);
    });
  });
});
