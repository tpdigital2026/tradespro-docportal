import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { FJC_COLOURS } from '../../src/db/seed-fjc';
import { FJC_WORDING } from '../../src/db/wording';
import { approveSurveyPartWith, deleteSurveyPhotoWith, readSurveyPhotoWith, saveSurveyWith, SurveyError, uploadSurveyPhotoWith } from '../../src/lib/data/surveys';
import { DEFAULT_CONFIRMATION } from '../../src/lib/documents/confirmation';
import { DocumentError, finaliseWith, previewWith, reviseWith, type RenderFn } from '../../src/lib/documents/finalise';
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
const F1 = 'f-abcdef1234';
/** A draft with one empty finding saved, so photos can be added to it. */
async function withFinding(c: Client, f: Fx, id = F1) {
  const first = await saveSurveyWith(c, f, { documentId: null, customer: newCustomer, job: { kind: 'new', reference: ref() }, values: values() }, '2026-10-14', nested);
  return saveSurveyWith(c, f, { documentId: first.documentId, customer: null, job: null, values: values({ findings: [emptyFinding(id)] }) }, '2026-10-14', nested);
}
async function staffOf(c: Client, f: Fx, name = 'Sam Staff'): Promise<Fx> {
  const userId = randomUUID();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), now())`, [userId, `${userId}@example.test`]);
  await c.query(`insert into public.profiles (id, tenant_id, role, full_name, email) values ($1, $2, 'staff', $3, $4)`, [userId, f.tenantId, name, `${userId}@example.test`]);
  return { tenantId: f.tenantId, userId };
}

/** A survey with one complete finding (one photo) and a written opinion, nothing approved yet. */
async function readySurvey(c: Client, f: Fx, storage: InMemoryStorage) {
  const first = await withFinding(c, f);
  const photo = await uploadSurveyPhotoWith(c, storage, f, first.documentId, F1, await placeholderPhoto(1, 800, 600), nested);
  const finding = { ...emptyFinding(F1), photoIds: [photo.id], ownerLine: 'gutter blocked', title: 'Gutter blocked', observation: 'The gutter is blocked.', assessment: 'In my assessment it needs clearing.' };
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
      const s = await withFinding(c, f);
      const photo = await uploadSurveyPhotoWith(c, storage, f, s.documentId, F1, await placeholderPhoto(0, 2600, 1300), nested);
      expect(photo.width).toBe(2000);
      const row = await c.query(`select storage_path, sha256, bytes, job_id from public.job_photos where id = $1`, [photo.id]);
      expect(row.rows[0].storage_path).toBe(`${f.tenantId}/${s.customerId}/${s.jobId}/${photo.id}.jpg`);
      expect(row.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(storage.objects.has(row.rows[0].storage_path)).toBe(true);
      expect(await readSurveyPhotoWith(c, storage, f.tenantId, photo.id)).not.toBeNull();
      expect(await readSurveyPhotoWith(c, storage, other.tenantId, photo.id)).toBeNull();
      // A crafted save naming a photo of another job keeps only the job's own photos.
      const foreign = randomUUID();
      const saved = await saveSurveyWith(c, f, { documentId: s.documentId, customer: null, job: null, values: values({ findings: [{ ...emptyFinding(F1), photoIds: [photo.id, foreign] }] }) }, '2026-10-14', nested);
      expect(saved.values.findings[0].photoIds).toEqual([photo.id]);
      await expect(uploadSurveyPhotoWith(c, storage, other, s.documentId, F1, await placeholderPhoto(1), nested)).rejects.toSatisfy((e: unknown) => e instanceof SurveyError && e.code === 'not_found');
      // A finding the draft does not have takes no photos, and the check is made before any image work.
      await expect(uploadSurveyPhotoWith(c, storage, f, s.documentId, 'f-notsaved99', Buffer.from('not even an image'), nested)).rejects.toThrow(/not saved yet/);
      // While the draft still shows the photo it cannot be deleted; once taken out of the finding it can.
      await expect(deleteSurveyPhotoWith(c, storage, f, s.documentId, photo.id, nested)).rejects.toThrow(/still in a finding/);
      await saveSurveyWith(c, f, { documentId: s.documentId, customer: null, job: null, values: values({ findings: [emptyFinding(F1)] }) }, '2026-10-14', nested);
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
      const s = await withFinding(c, f);
      await expect(uploadSurveyPhotoWith(c, storage, f, s.documentId, F1, await placeholderPhoto(0, 800, 600), nested)).rejects.toThrow(/could not be stored/);
      expect((await c.query(`select count(*)::int as n from public.job_photos where job_id = $1`, [s.jobId])).rows[0].n).toBe(0);
      await expect(uploadSurveyPhotoWith(c, new InMemoryStorage(), f, s.documentId, F1, Buffer.from('%PDF-1.4 not a photo'), nested)).rejects.toThrow(/not a photo/);
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

  it('photo limits count what the draft shows: four on a finding, then refused before any image work', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const storage = new InMemoryStorage();
      const s = await withFinding(c, f);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const p = await uploadSurveyPhotoWith(c, storage, f, s.documentId, F1, await placeholderPhoto(i, 400, 300), nested);
        ids.push(p.id);
        await saveSurveyWith(c, f, { documentId: s.documentId, customer: null, job: null, values: values({ findings: [{ ...emptyFinding(F1), photoIds: [...ids] }] }) }, '2026-10-14', nested);
      }
      await expect(uploadSurveyPhotoWith(c, storage, f, s.documentId, F1, Buffer.from('garbage'), nested)).rejects.toSatisfy((e: unknown) => e instanceof SurveyError && e.code === 'limit');
    });
  });

  it('the database ties a photo path to its own tenant, customer, job and photo id', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const s = await withFinding(c, f);
      const otherCust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'Someone Else') returning id`, [f.tenantId]);
      const id = randomUUID();
      const refused = async (path: string, re: RegExp) => {
        await c.query('savepoint p');
        await expect(c.query(`insert into public.job_photos (id, tenant_id, job_id, storage_path) values ($1, $2, $3, $4)`, [id, f.tenantId, s.jobId, path])).rejects.toThrow(re);
        await c.query('rollback to savepoint p');
      };
      await refused(`${f.tenantId}/${otherCust.rows[0].id}/${s.jobId}/${id}.jpg`, /own customer/);
      await refused(`${f.tenantId}/${s.customerId}/${s.jobId}/${randomUUID()}.jpg`, /job_photos_path_shape/);
      await refused(`${f.tenantId}/photos/x.jpg`, /job_photos_path_shape/);
      await c.query(`insert into public.job_photos (id, tenant_id, job_id, storage_path) values ($1, $2, $3, $4)`, [id, f.tenantId, s.jobId, `${f.tenantId}/${s.customerId}/${s.jobId}/${id}.jpg`]);
    });
  });

  it('the opinion is signed by the person who approves it: names are forced to the profile, staff cannot approve under the owner name', async () => {
    await withRollback(async (c) => {
      const owner = await business(c);
      const storage = new InMemoryStorage();
      const s = await readySurvey(c, owner, storage);
      const staff = await staffOf(c, owner);
      // Staff save the draft with the owner's name typed in: the server stores the staff member's own name.
      const saved = await saveSurveyWith(c, staff, { documentId: s.documentId, customer: null, job: null, values: { ...s.v, preparedBy: 'Test Owner', signName: 'Test Owner' } }, '2026-10-14', nested);
      expect(saved.values.signName).toBe('Sam Staff');
      expect(saved.values.preparedBy).toBe('Sam Staff');
      // Approving with the owner's name is refused outright.
      await expect(approveSurveyPartWith(c, staff, s.documentId, { ...saved.values, signName: 'Test Owner', preparedBy: 'Test Owner' }, { kind: 'opinion' }, nested)).rejects.toThrow(/your own name, Sam Staff/);
      // Approving as themselves works, and the audit row records who and in what role.
      const a = await approveSurveyPartWith(c, staff, s.documentId, saved.values, { kind: 'opinion' }, nested);
      expect(a.values.opinionHash).toBe(opinionHash(saved.values));
      const audit = await c.query(`select user_id, meta from public.audit_log where tenant_id = $1 and meta->>'part' = 'opinion'`, [owner.tenantId]);
      expect(audit.rows[0].user_id).toBe(staff.userId);
      expect(audit.rows[0].meta.role).toBe('staff');
      // A draft forged to carry the owner's name with that approval is refused at finalise.
      const forged = { ...a.values, signName: 'Test Owner', preparedBy: 'Test Owner' };
      const forgedHash = opinionHash(forged);
      await c.query(`update public.document_versions set input = $1::jsonb where document_id = $2`, [JSON.stringify({ schema: 1, survey: { ...forged, opinionHash: forgedHash } }), s.documentId]);
      await c.query(`insert into public.audit_log (tenant_id, user_id, action, entity, entity_id, meta) values ($1, $2, 'survey.approve', 'document', $3, $4)`, [owner.tenantId, staff.userId, s.documentId.replace(/-/g, ''), JSON.stringify({ part: 'opinion', hash: forgedHash })]);
      const { surveyApprovalProblemsWith } = await import('../../src/lib/survey/approval-sql');
      const problems = await surveyApprovalProblemsWith(c, owner.tenantId, s.documentId, { ...forged, opinionHash: forgedHash });
      expect(problems.join(' ')).toMatch(/approved by the person who signs it/);
    });
  });

  it('changing the signing date clears the opinion approval', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const s = await readySurvey(c, f, new InMemoryStorage());
      const a = await approveSurveyPartWith(c, f, s.documentId, s.v, { kind: 'opinion' }, nested);
      expect(a.values.opinionHash).not.toBeNull();
      const moved = await saveSurveyWith(c, f, { documentId: s.documentId, customer: null, job: null, values: { ...a.values, signDate: '2026-10-20' } }, '2026-10-14', nested);
      expect(moved.values.opinionHash).toBeNull();
      expect(moved.values.opinionApprovedAt).toBeNull();
    });
  });

  it('a correction to an issued report is a new version with every approval taken off; the quote uses the issued address', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const storage = new InMemoryStorage();
      const s = await readySurvey(c, f, storage);
      const a1 = await approveSurveyPartWith(c, f, s.documentId, s.v, { kind: 'finding', findingId: F1 }, nested);
      const a2 = await approveSurveyPartWith(c, f, s.documentId, a1.values, { kind: 'opinion' }, nested);
      const p = await previewWith(c, storage, f, s.documentId, { render, secret: SECRET });
      if (!p.ok) throw new Error(p.missing.join('; '));
      const tokens = [1, 2].map((n) => readToken(SECRET, { tenantId: f.tenantId, userId: f.userId, documentId: s.documentId, versionId: p.preview.versionId, key: p.preview.key }, n));
      await finaliseWith(c, storage, f, { documentId: s.documentId, versionId: p.preview.versionId, key: p.preview.key, tokens, confirmed: true, confirmationVersion: DEFAULT_CONFIRMATION.version }, { render, secret: SECRET }, nested);
      const r = await reviseWith(c, f, s.documentId, nested);
      const doc = await c.query(`select status::text from public.documents where id = $1`, [s.documentId]);
      expect(doc.rows[0].status).toBe('draft');
      const v2 = await c.query(`select version, input from public.document_versions where id = $1`, [r.versionId]);
      expect(v2.rows[0].version).toBe(2);
      expect(v2.rows[0].input.survey.findings[0].approvalHash).toBeNull();
      expect(v2.rows[0].input.survey.opinionHash).toBeNull();
      expect(a2.values.opinionHash).not.toBeNull();
      // The correction must be approved again before it can be finalised.
      const blocked = await previewWith(c, storage, f, s.documentId, { render, secret: SECRET });
      expect(blocked.ok).toBe(false);
      // A change of address in the correction does not reach the quote until it is issued.
      await saveSurveyWith(c, f, { documentId: s.documentId, customer: null, job: null, values: { ...v2.rows[0].input.survey, propertyAddress: '9 Changed Street, BR1 1AA' } }, '2026-10-14', nested);
      const issued = await c.query(`select input from public.document_versions where document_id = $1 and finalised_at is not null order by version desc limit 1`, [s.documentId]);
      expect(issued.rows[0].input.survey.propertyAddress).toBe('123 Bromley Road, BR1 1AA');
    });
  });

  it('deleting a photo removes the row first; a failed file delete leaves no row behind (the file is left for the sweep)', async () => {
    await withRollback(async (c) => {
      const f = await business(c);
      const storage = new InMemoryStorage();
      const s = await withFinding(c, f);
      const photo = await uploadSurveyPhotoWith(c, storage, f, s.documentId, F1, await placeholderPhoto(2, 400, 300), nested);
      storage.failNext = true;
      await deleteSurveyPhotoWith(c, storage, f, s.documentId, photo.id, nested);
      expect((await c.query(`select 1 from public.job_photos where id = $1`, [photo.id])).rowCount).toBe(0);
    });
  });
});
