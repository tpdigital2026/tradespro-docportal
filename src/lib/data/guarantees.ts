/**
 * Guarantee certificates: the draft, its autosave and the lists the form needs. What the screens and actions call.
 *
 * Every write runs on a service connection in ONE transaction, with the tenant and the person taken from the session and
 * every id from the browser re-checked against that tenant (as for invoices, receipts and survey reports, README "Server
 * code rules"). The job row is locked first, then the document. Demo mode keeps everything in memory with dummy data.
 *
 * A certificate belongs to a job and is numbered after it: GC-{job number}, GC-{job number}-G2 and so on. A job has at most
 * one certificate per roof type (also enforced by the database). The issue date is never typed: the draft's date is today
 * when it is made, and it is set to today again when the certificate is finalised.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { writeAudit } from '../../security/audit';
import type { Db } from '../../security/login-guard';
import { demoSlot, isDemo } from '../demo';
import { demoBusinessFacts } from '../demo-business';
import { demoGuaranteeRows, type DemoGuarantee } from '../demo-guarantees';
import { guaranteeErrors, nextCertificateSeq, parseGuaranteeInput, roofKeyOf, roofLabel, storedGuarantee, tidyGuarantee, type GuaranteeValues } from '../guarantee/model';
import { documentNumberFor, MAX_GUARANTEES_PER_JOB } from '../job-stage';
import { todayLondon } from '../payment';
import { requireSession } from '../session';
import { NUMBER_RE, NUMBER_SUFFIX_MESSAGE, quoteNumberReserved } from '../validation/quote';
import { compactId, withServiceConnection, type Actor } from './customer-admin';
import { listCustomers, ownerClient } from './customers';
import { isKnownId, isRealId } from './quotes';
import { retryOnDeadlock } from './retry';

export type GuaranteeErrorCode = 'invalid' | 'exists' | 'locked' | 'not_found' | 'limit' | 'number_used' | 'failed';

export class GuaranteeError extends Error {
  constructor(
    readonly code: GuaranteeErrorCode,
    message: string,
    readonly field?: string,
    /** For 'exists': the certificate already made for that roof, so the screen can open it. */
    readonly existingId?: string,
  ) {
    super(message);
    this.name = 'GuaranteeError';
  }
}

export interface CertificateRef {
  documentId: string;
  number: string;
  roof: string;
  /** The roof key (roofKeyOf), so the form can say which roofs are taken. */
  roofKey: string;
  status: 'draft' | 'final';
}

export interface GuaranteeJobOption {
  id: string;
  reference: string;
  customerId: string;
  customerName: string;
  propertyAddress: string;
  /** The job has a quotation, so its number can be linked. */
  hasQuote: boolean;
  /** The certificates already made for this job. */
  certificates: CertificateRef[];
}

export interface GuaranteeContext {
  /** The London date: the issue date, and the latest a completion date may be. */
  today: string;
  customers: { id: string; name: string; addressLine: string; postcode: string }[];
  jobs: GuaranteeJobOption[];
}

export interface GuaranteeDraft {
  documentId: string;
  jobId: string;
  jobReference: string;
  customerId: string;
  customerName: string;
  number: string;
  status: 'draft' | 'final';
  values: GuaranteeValues;
}

export type JobChoice = { kind: 'existing'; id: string } | { kind: 'new'; customerId: string; reference: string };

export interface SaveGuaranteeRequest {
  /** null for the first save, which creates the document (and the job, if new). */
  documentId: string | null;
  job: JobChoice | null;
  values: GuaranteeValues;
}

export interface SavedGuarantee {
  documentId: string;
  jobId: string;
  customerId: string;
  number: string;
  jobReference: string;
  savedAt: string;
  values: GuaranteeValues;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TxOpts {
  nested?: boolean;
}

async function tx<T>(db: Db, name: string, o: TxOpts, fn: () => Promise<T>): Promise<T> {
  const nested = o.nested === true;
  await db.query(nested ? `savepoint ${name}` : 'begin');
  try {
    if (!nested) {
      await db.query('reset role');
      await db.query(`select set_config('request.jwt.claims', '', true)`);
    }
    const out = await fn();
    await db.query(nested ? `release savepoint ${name}` : 'commit');
    return out;
  } catch (e) {
    await db.query(nested ? `rollback to savepoint ${name}` : 'rollback').catch(() => undefined);
    throw e;
  }
}

/** What a draft may hold: nothing wrong in what has been typed. Boxes still empty are fine until the certificate is issued. */
function checkDraft(v: GuaranteeValues, today: string, first: boolean): void {
  const errors = guaranteeErrors(v, today);
  if (first && v.roofType === '') throw new GuaranteeError('invalid', 'Choose the type of roof first.', 'roofType');
  const empty: Record<string, boolean> = { roofType: v.roofType === '', roofOther: v.roofOther.trim() === '', years: v.years === '', address: v.address === '', completedOn: v.completedOn === '' };
  for (const [field, message] of Object.entries(errors)) {
    if (field in empty && empty[field] && !(field === 'roofOther' && v.roofType === 'other' && first)) continue;
    throw new GuaranteeError('invalid', message as string, field);
  }
}

/** Another certificate of this job for the same roof (not void), if there is one. */
async function roofConflictWith(db: Db, tenantId: string, jobId: string, exceptDocumentId: string | null, key: string): Promise<{ id: string; number: string } | null> {
  if (key === '') return null;
  const r = await db.query(
    `select d.id, d.number from public.documents d join public.document_versions v on v.id = d.current_version_id and v.tenant_id = d.tenant_id
      where d.tenant_id = $1 and d.job_id = $2 and d.type = 'guarantee' and d.status <> 'void' and ($3::uuid is null or d.id <> $3::uuid)
        and v.input -> 'guarantee' ->> 'roofKey' = $4 limit 1`,
    [tenantId, jobId, exceptDocumentId, key],
  );
  return r.rows[0] ? { id: String(r.rows[0].id), number: String(r.rows[0].number) } : null;
}

const existsError = (label: string, c: { id: string; number: string }) =>
  new GuaranteeError('exists', `This job already has a certificate for the ${label.toLowerCase() || 'same'} roof (${c.number}). Open that one instead.`, 'roofType', c.id);

async function quoteExistsWith(db: Db, tenantId: string, number: string): Promise<boolean> {
  const r = await db.query(`select 1 from public.documents where tenant_id = $1 and type = 'quotation' and number = $2 limit 1`, [tenantId, number]);
  return Boolean(r.rows[0]);
}

export async function saveGuaranteeWith(db: Db, actor: Actor, req: SaveGuaranteeRequest, today: string, o: TxOpts = {}): Promise<SavedGuarantee> {
  const values = tidyGuarantee(req.values);
  checkDraft(values, today, req.documentId === null);
  const key = roofKeyOf(values);
  return tx(db, 'guarantee_save', o, async () => {
    if (values.linkedQuote && !(await quoteExistsWith(db, actor.tenantId, values.linkedQuote))) throw new GuaranteeError('invalid', 'That is not the number of one of your quotes.', 'linkedQuote');
    try {
      if (req.documentId) {
        if (!UUID.test(req.documentId)) throw new GuaranteeError('not_found', 'That certificate could not be found.');
        // The job row first, then the document (the same order everywhere).
        const j = await db.query(
          `select j.id, j.reference, j.customer_id from public.jobs j where j.tenant_id = $2
              and j.id = (select d.job_id from public.documents d where d.id = $1 and d.tenant_id = $2 and d.type = 'guarantee') for update of j`,
          [req.documentId, actor.tenantId],
        );
        const job = j.rows[0];
        if (!job) throw new GuaranteeError('not_found', 'That certificate could not be found.');
        const d = await db.query(`select id, number, status::text as status from public.documents where id = $1 and tenant_id = $2 for update`, [req.documentId, actor.tenantId]);
        const v = await db.query(`select id, finalised_at from public.document_versions where document_id = $1 and tenant_id = $2 order by version desc limit 1 for update`, [req.documentId, actor.tenantId]);
        if (d.rows[0]?.status !== 'draft' || !v.rows[0] || v.rows[0].finalised_at) throw new GuaranteeError('locked', 'This certificate has been finalised and can no longer be changed.');
        const clash = await roofConflictWith(db, actor.tenantId, String(job.id), req.documentId, key);
        if (clash) throw existsError(roofLabel(values), clash);
        await db.query(`update public.document_versions set input = $1::jsonb where id = $2 and tenant_id = $3`, [JSON.stringify(storedGuarantee(values)), v.rows[0].id, actor.tenantId]);
        return { documentId: req.documentId, jobId: String(job.id), customerId: String(job.customer_id), number: String(d.rows[0].number), jobReference: String(job.reference), savedAt: new Date().toISOString(), values };
      }

      // First save: the job (found or made), the document and its first version, together or not at all.
      if (!req.job) throw new GuaranteeError('invalid', 'Choose the job the certificate is for.', 'job');
      let jobId: string;
      let reference: string;
      let customerId: string;
      if (req.job.kind === 'existing') {
        if (!UUID.test(req.job.id)) throw new GuaranteeError('invalid', 'Choose the job the certificate is for.', 'job');
        const j = await db.query(`select id, reference, customer_id from public.jobs where id = $1 and tenant_id = $2 for update`, [req.job.id, actor.tenantId]);
        if (!j.rows[0]) throw new GuaranteeError('invalid', 'That job could not be found.', 'job');
        jobId = String(j.rows[0].id);
        reference = String(j.rows[0].reference);
        customerId = String(j.rows[0].customer_id);
      } else {
        if (!UUID.test(req.job.customerId)) throw new GuaranteeError('invalid', 'Choose the customer.', 'customer');
        const c = await db.query(`select id from public.customers where id = $1 and tenant_id = $2`, [req.job.customerId, actor.tenantId]);
        if (!c.rows[0]) throw new GuaranteeError('invalid', 'That customer could not be found.', 'customer');
        reference = req.job.reference.trim();
        if (!NUMBER_RE.test(reference)) throw new GuaranteeError('invalid', 'Use 2 to 40 letters, numbers, dots, dashes or slashes, starting with a letter or number', 'jobReference');
        if (quoteNumberReserved(reference) !== null) throw new GuaranteeError('invalid', NUMBER_SUFFIX_MESSAGE, 'jobReference');
        await db.query('savepoint guarantee_job');
        try {
          const ins = await db.query(`insert into public.jobs (tenant_id, customer_id, reference, property_address, created_by) values ($1, $2, $3, $4, $5) returning id`, [actor.tenantId, req.job.customerId, reference, values.address || null, actor.userId]);
          jobId = String(ins.rows[0].id);
          await db.query('release savepoint guarantee_job');
        } catch (e) {
          await db.query('rollback to savepoint guarantee_job');
          if ((e as { code?: string }).code === '23505') throw new GuaranteeError('number_used', 'That job number has already been used. Choose another.', 'jobReference');
          if ((e as { code?: string }).code === '23514') throw new GuaranteeError('invalid', NUMBER_SUFFIX_MESSAGE, 'jobReference');
          throw e;
        }
        customerId = req.job.customerId;
      }
      const clash = await roofConflictWith(db, actor.tenantId, jobId, null, key);
      if (clash) throw existsError(roofLabel(values), clash);
      // Numbers burnt are never reused (a certificate that was deleted still holds its number), so the registry is read too.
      const candidates = Array.from({ length: MAX_GUARANTEES_PER_JOB }, (_, i) => documentNumberFor('guarantee', reference, 'full', 1, i + 1) as string);
      const used = await db.query(
        `select number from public.documents where job_id = $1 and tenant_id = $2 and type = 'guarantee'
         union select number from public.used_numbers where tenant_id = $2 and number = any ($3::text[])`,
        [jobId, actor.tenantId, candidates],
      );
      const seq = nextCertificateSeq(reference, used.rows.map((r) => String(r.number)));
      const number = seq === null ? null : documentNumberFor('guarantee', reference, 'full', 1, seq);
      if (!number) throw new GuaranteeError('limit', 'This job has as many certificates as it can hold.');
      const doc = await db.query(`insert into public.documents (tenant_id, job_id, type, number, doc_date, created_by) values ($1, $2, 'guarantee', $3, $4, $5) returning id`, [actor.tenantId, jobId, number, today, actor.userId]);
      const documentId = String(doc.rows[0].id);
      const ver = await db.query(`insert into public.document_versions (tenant_id, document_id, version, input, created_by) values ($1, $2, 1, $3::jsonb, $4) returning id`, [actor.tenantId, documentId, JSON.stringify(storedGuarantee(values)), actor.userId]);
      await db.query(`update public.documents set current_version_id = $1 where id = $2 and tenant_id = $3`, [ver.rows[0].id, documentId, actor.tenantId]);
      await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'guarantee.create', entity: 'document', entityId: compactId(documentId), meta: { version: compactId(String(ver.rows[0].id)), roof: values.roofType, years: values.years } });
      return { documentId, jobId, customerId, number, jobReference: reference, savedAt: new Date().toISOString(), values };
    } catch (e) {
      const code = (e as { code?: string }).code;
      const msg = String((e as { message?: string }).message ?? '');
      if (code === '23514' && /already has a guarantee certificate/.test(msg)) throw new GuaranteeError('exists', 'This job already has a certificate for that roof. Open that one instead.', 'roofType');
      if (code === '23505') throw new GuaranteeError('number_used', 'That certificate number has already been used. Please try again.');
      throw e;
    }
  });
}

// ---------------------------------------------------------------- demo mode (in memory, dummy data)

const demoSeq = demoSlot<{ n: number }>('guarantee-seq', () => ({ n: 0 }));

function demoCertificates(jobId: string): CertificateRef[] {
  return demoGuaranteeRows()
    .filter((r) => r.jobId === jobId)
    .map((r) => ({ documentId: r.id, number: r.number, roof: roofLabel(r.values), roofKey: roofKeyOf(r.values), status: r.status }));
}

async function demoJobs(): Promise<GuaranteeJobOption[]> {
  const customers = await listCustomers();
  const name = (id: string) => customers.find((c) => c.id === id)?.name ?? 'Customer';
  return demoBusinessFacts().jobs.map((j) => ({
    id: j.jobId,
    reference: j.quoteNumber,
    customerId: j.customerId,
    customerName: name(j.customerId) || j.customerName,
    propertyAddress: j.addressLine,
    hasQuote: j.documents.some((d) => d.type === 'quotation'),
    certificates: demoCertificates(j.jobId),
  }));
}

async function demoSave(req: SaveGuaranteeRequest): Promise<SavedGuarantee> {
  const today = todayLondon();
  const values = tidyGuarantee(req.values);
  checkDraft(values, today, req.documentId === null);
  const key = roofKeyOf(values);
  const rows = demoGuaranteeRows();
  const jobs = await demoJobs();
  const clash = (jobId: string, except: string | null) => rows.find((r) => r.jobId === jobId && r.id !== except && roofKeyOf(r.values) === key);
  if (values.linkedQuote && !jobs.some((j) => j.reference === values.linkedQuote && j.hasQuote)) throw new GuaranteeError('invalid', 'That is not the number of one of your quotes.', 'linkedQuote');
  if (req.documentId) {
    const row = rows.find((r) => r.id === req.documentId);
    if (!row) throw new GuaranteeError('not_found', 'That certificate could not be found.');
    if (row.status !== 'draft') throw new GuaranteeError('locked', 'This certificate has been finalised and can no longer be changed.');
    const c = clash(row.jobId, row.id);
    if (c) throw existsError(roofLabel(values), { id: c.id, number: c.number });
    row.values = values;
    const job = jobs.find((j) => j.id === row.jobId);
    return { documentId: row.id, jobId: row.jobId, customerId: row.customerId, number: row.number, jobReference: job?.reference ?? '', savedAt: new Date().toISOString(), values };
  }
  if (!req.job) throw new GuaranteeError('invalid', 'Choose the job the certificate is for.', 'job');
  let job: GuaranteeJobOption | undefined;
  if (req.job.kind === 'existing') {
    const id = req.job.id;
    job = jobs.find((j) => j.id === id);
    if (!job) throw new GuaranteeError('invalid', 'That job could not be found.', 'job');
  } else {
    const ref = req.job.reference.trim();
    if (!NUMBER_RE.test(ref)) throw new GuaranteeError('invalid', 'Use 2 to 40 letters, numbers, dots, dashes or slashes, starting with a letter or number', 'jobReference');
    if (quoteNumberReserved(ref) !== null) throw new GuaranteeError('invalid', NUMBER_SUFFIX_MESSAGE, 'jobReference');
    if (jobs.some((j) => j.reference === ref)) throw new GuaranteeError('number_used', 'That job number has already been used. Choose another.', 'jobReference');
    const customers = await listCustomers();
    const cust = customers.find((c) => c.id === (req.job as { customerId: string }).customerId);
    if (!cust) throw new GuaranteeError('invalid', 'That customer could not be found.', 'customer');
    job = { id: `demo-job-gc-${ref.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`, reference: ref, customerId: cust.id, customerName: cust.name, propertyAddress: values.address, hasQuote: false, certificates: [] };
  }
  const c = clash(job.id, null);
  if (c) throw existsError(roofLabel(values), { id: c.id, number: c.number });
  const seq = nextCertificateSeq(job.reference, rows.filter((r) => r.jobId === job.id).map((r) => r.number));
  const number = seq === null ? null : documentNumberFor('guarantee', job.reference, 'full', 1, seq);
  if (!number) throw new GuaranteeError('limit', 'This job has as many certificates as it can hold.');
  demoSeq.get().n += 1;
  const row: DemoGuarantee = { id: `demo-guarantee-${demoSeq.get().n}-${randomUUID().slice(0, 8)}`, jobId: job.id, customerId: job.customerId, number, status: 'draft', values, createdAt: new Date().toISOString(), docDate: today, finalisedAt: null };
  rows.push(row);
  return { documentId: row.id, jobId: job.id, customerId: job.customerId, number, jobReference: job.reference, savedAt: new Date().toISOString(), values };
}

// ---------------------------------------------------------------- the functions the screens call

export async function getGuaranteeContext(): Promise<GuaranteeContext> {
  await requireSession();
  const today = todayLondon();
  if (isDemo()) {
    const customers = (await listCustomers()).map((c) => ({ id: c.id, name: c.name, addressLine: c.addressLines[0] ?? '', postcode: c.postcode }));
    return { today, customers, jobs: await demoJobs() };
  }
  const client = await ownerClient();
  const [custs, jobs, docs] = await Promise.all([
    client.from('customers').select('id, name, postcode, address_lines').order('last_activity_at', { ascending: false }).limit(500),
    client.from('jobs').select('id, reference, customer_id, property_address').order('created_at', { ascending: false }).limit(300),
    client.from('documents').select('id, job_id, type, number, status, current_version_id').in('type', ['guarantee', 'quotation']).limit(2000),
  ]);
  if (custs.error || jobs.error || docs.error) throw new GuaranteeError('failed', 'Could not load your customers and jobs.');
  const docRows = (docs.data ?? []) as { id: string; job_id: string; type: string; number: string; status: string; current_version_id: string | null }[];
  const gDocs = docRows.filter((d) => d.type === 'guarantee' && d.status !== 'void');
  const versionIds = gDocs.map((d) => d.current_version_id).filter((x): x is string => typeof x === 'string');
  const vers = versionIds.length ? await client.from('document_versions').select('id, input').in('id', versionIds) : { data: [], error: null };
  if (vers.error) throw new GuaranteeError('failed', 'Could not load your certificates.');
  const inputs = new Map(((vers.data ?? []) as { id: string; input: unknown }[]).map((v) => [v.id, v.input]));
  const customerRows = (custs.data ?? []) as { id: string; name: string; postcode: string | null; address_lines: string[] | null }[];
  const names = new Map(customerRows.map((c) => [c.id, c.name]));
  return {
    today,
    customers: customerRows.map((c) => ({ id: c.id, name: c.name, postcode: c.postcode ?? '', addressLine: c.address_lines?.[0] ?? '' })),
    jobs: ((jobs.data ?? []) as { id: string; reference: string; customer_id: string; property_address: string | null }[]).map((j) => ({
      id: j.id,
      reference: j.reference,
      customerId: j.customer_id,
      customerName: names.get(j.customer_id) ?? 'Customer',
      propertyAddress: j.property_address ?? '',
      hasQuote: docRows.some((d) => d.job_id === j.id && d.type === 'quotation'),
      certificates: gDocs
        .filter((d) => d.job_id === j.id)
        .map((d) => {
          const v = parseGuaranteeInput(d.current_version_id ? inputs.get(d.current_version_id) : null);
          return { documentId: d.id, number: d.number, roof: v ? roofLabel(v) : '', roofKey: v ? roofKeyOf(v) : '', status: d.status === 'draft' ? ('draft' as const) : ('final' as const) };
        }),
    })),
  };
}

export async function getGuaranteeDraft(documentId: string): Promise<GuaranteeDraft | null> {
  const s = await requireSession();
  if (!isKnownId(documentId)) return null;
  if (isDemo()) {
    const row = demoGuaranteeRows().find((r) => r.id === documentId);
    if (!row) return null;
    const job = (await demoJobs()).find((j) => j.id === row.jobId);
    return { documentId: row.id, jobId: row.jobId, jobReference: job?.reference ?? '', customerId: row.customerId, customerName: job?.customerName ?? 'Customer', number: row.number, status: row.status, values: structuredClone(row.values) };
  }
  if (!isRealId(documentId)) return null;
  return withServiceConnection(async (db) => {
    const d = await db.query(
      `select d.id, d.job_id, d.number, d.status::text as status, j.customer_id, j.reference, c.name
         from public.documents d join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
         join public.customers c on c.id = j.customer_id and c.tenant_id = j.tenant_id
        where d.id = $1 and d.tenant_id = $2 and d.type = 'guarantee'`,
      [documentId, s.tenantId],
    );
    const r = d.rows[0];
    if (!r) return null;
    const v = await db.query(`select input from public.document_versions where document_id = $1 and tenant_id = $2 order by version desc limit 1`, [documentId, s.tenantId]);
    return {
      documentId: String(r.id),
      jobId: String(r.job_id),
      jobReference: String(r.reference),
      customerId: String(r.customer_id),
      customerName: String(r.name),
      number: String(r.number),
      status: r.status === 'draft' ? 'draft' : 'final',
      values: parseGuaranteeInput(v.rows[0]?.input) ?? tidyGuarantee({ roofType: '', roofOther: '', years: '', address: '', completedOn: '', linkedQuote: '' }),
    } satisfies GuaranteeDraft;
  });
}

export async function saveGuarantee(req: SaveGuaranteeRequest): Promise<SavedGuarantee> {
  const s = await requireSession();
  if (isDemo()) return demoSave(req);
  return withServiceConnection((db) => retryOnDeadlock(() => saveGuaranteeWith(db, { tenantId: s.tenantId, userId: s.userId }, req, todayLondon())));
}
