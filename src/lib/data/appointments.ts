/**
 * Appointments: reads on a service connection with the session's tenant in every query; writes through the owner's
 * own session (row level security and the column grants apply, and the database fills in the customer from a job).
 * Demo mode keeps them in memory.
 */
import 'server-only';
import { isDemo } from '../demo';
import { demoCustomers } from '../demo-data';
import { requireSession } from '../session';
import { demoAppointments, demoBusinessFacts } from '../demo-business';
import type { Appointment, AppointmentInput, AppointmentKind } from '../calendar/model';
import { withServiceConnection } from './customer-admin';
import { ownerClient, type DataClient } from './customers';
import { isRealId } from './quotes';
import type { Db } from '../../security/login-guard';

export class AppointmentError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'failed',
    message: string,
    readonly field?: 'customerId' | 'jobId',
  ) {
    super(message);
    this.name = 'AppointmentError';
  }
}

const KINDS: readonly string[] = ['site_visit', 'survey', 'job_start', 'job_finish', 'other'];
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function toAppointment(r: Record<string, unknown>): Appointment {
  return {
    id: String(r.id),
    kind: (KINDS.includes(String(r.kind)) ? String(r.kind) : 'other') as AppointmentKind,
    title: String(r.title),
    startsAt: iso(r.starts_at),
    endsAt: r.ends_at ? iso(r.ends_at) : null,
    customerId: r.customer_id ? String(r.customer_id) : null,
    customerName: r.customer_name ? String(r.customer_name) : null,
    jobId: r.job_id ? String(r.job_id) : null,
    quoteNumber: r.reference ? String(r.reference) : null,
    notes: r.notes ? String(r.notes) : null,
  };
}

const SELECT = `select a.id, a.kind, a.title, a.starts_at, a.ends_at, a.customer_id, a.job_id, a.notes, a.updated_at, c.name as customer_name, j.reference
  from public.appointments a
  left join public.customers c on c.id = a.customer_id and c.tenant_id = a.tenant_id
  left join public.jobs j on j.id = a.job_id and j.tenant_id = a.tenant_id`;

/** Appointments that overlap [from, to) (instants), earliest first. */
export async function listAppointmentsSql(db: Db, tenantId: string, from: Date, to: Date): Promise<Appointment[]> {
  const r = await db.query(
    `${SELECT}
      where a.tenant_id = $1 and a.starts_at < $3 and coalesce(a.ends_at, a.starts_at) >= $2
      order by a.starts_at, a.id
      limit 1000`,
    [tenantId, from.toISOString(), to.toISOString()],
  );
  return r.rows.map(toAppointment);
}

export async function getAppointmentSql(db: Db, tenantId: string, id: string): Promise<(Appointment & { updatedAt: string }) | null> {
  const r = await db.query(`${SELECT} where a.tenant_id = $1 and a.id = $2`, [tenantId, id]);
  return r.rows[0] ? { ...toAppointment(r.rows[0]), updatedAt: iso(r.rows[0].updated_at) } : null;
}

export interface LinkOptions {
  customers: { id: string; name: string }[];
  jobs: { id: string; quoteNumber: string; customerId: string; customerName: string }[];
}

export async function linkOptionsSql(db: Db, tenantId: string): Promise<LinkOptions> {
  const c = await db.query(`select id, name from public.customers where tenant_id = $1 order by lower(name), id limit 500`, [tenantId]);
  const j = await db.query(
    `select j.id, j.reference, j.customer_id, c.name from public.jobs j join public.customers c on c.id = j.customer_id and c.tenant_id = j.tenant_id
      where j.tenant_id = $1 order by j.created_at desc, j.id limit 500`,
    [tenantId],
  );
  return {
    customers: c.rows.map((x) => ({ id: String(x.id), name: String(x.name) })),
    jobs: j.rows.map((x) => ({ id: String(x.id), quoteNumber: String(x.reference), customerId: String(x.customer_id), customerName: String(x.name) })),
  };
}

// ---------------------------------------------------------------- writes (the owner's session)

function columns(v: AppointmentInput) {
  return { kind: v.kind, title: v.title, starts_at: v.startsAt.toISOString(), ends_at: v.endsAt ? v.endsAt.toISOString() : null, customer_id: v.customerId, job_id: v.jobId, notes: v.notes };
}

function mapWriteError(error: { code?: string; message?: string } | null): never {
  const code = error?.code;
  if (code === '23514' && /different customer/.test(String(error?.message))) throw new AppointmentError('invalid', 'That job belongs to a different customer. Choose the job or the customer again.', 'jobId');
  if (code === '23503') throw new AppointmentError('invalid', 'That customer or job could not be found.', 'customerId');
  throw new AppointmentError('failed', 'The appointment could not be saved. Please try again.');
}

export async function createAppointmentWith(client: DataClient, tenantId: string, v: AppointmentInput): Promise<string> {
  const { data, error } = await client.from('appointments').insert({ tenant_id: tenantId, ...columns(v) }).select('id').single();
  if (error || !data) mapWriteError(error);
  return String((data as { id: string }).id);
}

export async function updateAppointmentWith(client: DataClient, id: string, v: AppointmentInput): Promise<void> {
  const { data, error } = await client.from('appointments').update(columns(v)).eq('id', id).select('id');
  if (error) mapWriteError(error);
  if (!data || (data as unknown[]).length === 0) throw new AppointmentError('not_found', 'That appointment could not be found.');
}

export async function deleteAppointmentWith(client: DataClient, id: string): Promise<void> {
  const { data, error } = await client.from('appointments').delete().eq('id', id).select('id');
  if (error) throw new AppointmentError('failed', 'The appointment could not be deleted. Please try again.');
  if (!data || (data as unknown[]).length === 0) throw new AppointmentError('not_found', 'That appointment could not be found.');
}

// ---------------------------------------------------------------- what the screens call

const DEMO_ID = /^demo-appt-\d{1,6}$/;
export const isAppointmentId = (id: unknown): id is string => isRealId(id) || (isDemo() && typeof id === 'string' && DEMO_ID.test(id));

function demoLinks(): LinkOptions {
  const jobs = demoBusinessFacts().jobs;
  return {
    customers: demoCustomers.map((c) => ({ id: c.id, name: c.name })),
    jobs: jobs.map((j) => ({ id: j.jobId, quoteNumber: j.quoteNumber, customerId: j.customerId, customerName: j.customerName })),
  };
}

export async function listAppointments(from: Date, to: Date): Promise<Appointment[]> {
  const s = await requireSession();
  if (isDemo()) {
    return demoAppointments()
      .list.filter((a) => Date.parse(a.startsAt) < to.getTime() && Date.parse(a.endsAt ?? a.startsAt) >= from.getTime())
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  }
  return withServiceConnection((db) => listAppointmentsSql(db, s.tenantId, from, to));
}

export async function getAppointment(id: string): Promise<(Appointment & { updatedAt: string }) | null> {
  const s = await requireSession();
  if (!isAppointmentId(id)) return null;
  if (isDemo()) {
    const a = demoAppointments().list.find((x) => x.id === id);
    return a ? { ...a, updatedAt: a.startsAt } : null;
  }
  return withServiceConnection((db) => getAppointmentSql(db, s.tenantId, id));
}

export async function getLinkOptions(): Promise<LinkOptions> {
  const s = await requireSession();
  if (isDemo()) return demoLinks();
  return withServiceConnection((db) => linkOptionsSql(db, s.tenantId));
}

/** In demo mode the same rule as the database: a job implies its customer, and may not name someone else. */
function demoLinked(v: AppointmentInput): Pick<Appointment, 'customerId' | 'customerName' | 'jobId' | 'quoteNumber'> {
  const links = demoLinks();
  const job = v.jobId ? links.jobs.find((j) => j.id === v.jobId) : undefined;
  if (v.jobId && !job) throw new AppointmentError('invalid', 'That customer or job could not be found.', 'jobId');
  const customerId = v.customerId ?? job?.customerId ?? null;
  if (job && customerId !== job.customerId) throw new AppointmentError('invalid', 'That job belongs to a different customer. Choose the job or the customer again.', 'jobId');
  const customer = customerId ? links.customers.find((c) => c.id === customerId) : undefined;
  if (customerId && !customer) throw new AppointmentError('invalid', 'That customer or job could not be found.', 'customerId');
  return { customerId, customerName: customer?.name ?? null, jobId: job?.id ?? null, quoteNumber: job?.quoteNumber ?? null };
}

export async function saveAppointment(id: string | null, v: AppointmentInput): Promise<string> {
  const s = await requireSession();
  if (v.customerId && !isRealId(v.customerId) && !isDemo()) throw new AppointmentError('invalid', 'That customer or job could not be found.', 'customerId');
  if (v.jobId && !isRealId(v.jobId) && !isDemo()) throw new AppointmentError('invalid', 'That customer or job could not be found.', 'jobId');
  if (isDemo()) {
    const st = demoAppointments();
    const links = demoLinked(v);
    const row: Omit<Appointment, 'id'> = { kind: v.kind, title: v.title, startsAt: v.startsAt.toISOString(), endsAt: v.endsAt?.toISOString() ?? null, notes: v.notes, ...links };
    if (id) {
      const found = st.list.find((a) => a.id === id);
      if (!found) throw new AppointmentError('not_found', 'That appointment could not be found.');
      Object.assign(found, row);
      return id;
    }
    st.seq += 1;
    const newId = `demo-appt-${st.seq}`;
    st.list.push({ id: newId, ...row });
    return newId;
  }
  const client = await ownerClient();
  if (id) {
    if (!isRealId(id)) throw new AppointmentError('not_found', 'That appointment could not be found.');
    await updateAppointmentWith(client, id, v);
    return id;
  }
  return createAppointmentWith(client, s.tenantId, v);
}

export async function deleteAppointment(id: string): Promise<void> {
  await requireSession();
  if (isDemo()) {
    const st = demoAppointments();
    const before = st.list.length;
    st.list = st.list.filter((a) => a.id !== id);
    if (st.list.length === before) throw new AppointmentError('not_found', 'That appointment could not be found.');
    return;
  }
  if (!isRealId(id)) throw new AppointmentError('not_found', 'That appointment could not be found.');
  await deleteAppointmentWith(await ownerClient(), id);
}
