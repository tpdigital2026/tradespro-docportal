import { demoGuaranteeRows } from '../demo-guarantees';
import { cookies } from 'next/headers';
import { accessCookieName } from '../auth-cookies';
import { demoCustomers, demoQuotes } from '../demo-data';
import { isDemo } from '../demo';
import { DEFAULT_RETENTION_DAYS, safeRetentionDays } from '../retention';
import { requireSession } from '../session';
import { anonClient } from '../supabase-server';
import type { CustomerInput } from '../validation/customer';

export interface Customer {
  id: string;
  name: string;
  addressLines: string[];
  postcode: string;
  email: string | null;
  phone: string | null;
  lastActivityAt: string;
  purgeAt: string;
}

export interface CustomerDocument {
  id: string;
  type: string;
  number: string;
  status: string;
  date: string;
}

/** The slice of supabase-js these functions use, so tests can pass a stub. Row level security does the tenant scoping. */
export interface DataClient {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const LIST_LIMIT = 500;
const COLUMNS = 'id, name, address_lines, postcode, email, phone, last_activity_at, purge_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DataError extends Error {
  constructor() {
    super('The request could not be completed');
    this.name = 'DataError';
  }
}

interface Row {
  id: string;
  name: string;
  address_lines: string[] | null;
  postcode: string | null;
  email: string | null;
  phone: string | null;
  last_activity_at: string;
  purge_at: string;
}

function toCustomer(r: Row): Customer {
  return {
    id: r.id,
    name: r.name,
    addressLines: r.address_lines ?? [],
    postcode: r.postcode ?? '',
    email: r.email,
    phone: r.phone,
    lastActivityAt: r.last_activity_at,
    purgeAt: r.purge_at,
  };
}

/** Keeps letters, digits, spaces, apostrophes, dots and hyphens, so a search can never alter the filter. */
export function cleanSearch(raw: string | undefined): string {
  return (raw ?? '').normalize('NFKC').replace(/[^\p{L}\p{N} '.-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function toColumns(input: CustomerInput) {
  return { name: input.name, address_lines: input.addressLines, postcode: input.postcode, email: input.email, phone: input.phone };
}

/** Most recently active first. */
export async function listCustomersWith(client: DataClient, search?: string): Promise<Customer[]> {
  let q = client.from('customers').select(COLUMNS);
  const term = cleanSearch(search);
  if (term) q = q.or(`name.ilike.*${term}*,postcode.ilike.*${term}*`);
  const { data, error } = await q.order('last_activity_at', { ascending: false }).limit(LIST_LIMIT);
  if (error) throw new DataError();
  return ((data ?? []) as Row[]).map(toCustomer);
}

export async function getCustomerWith(client: DataClient, id: string): Promise<Customer | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await client.from('customers').select(COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new DataError();
  return data ? toCustomer(data as Row) : null;
}

export async function createCustomerWith(client: DataClient, tenantId: string, input: CustomerInput): Promise<Customer> {
  const { data, error } = await client.from('customers').insert({ tenant_id: tenantId, ...toColumns(input) }).select(COLUMNS).single();
  if (error || !data) throw new DataError();
  return toCustomer(data as Row);
}

export async function updateCustomerWith(client: DataClient, tenantId: string, id: string, input: CustomerInput): Promise<Customer | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await client.from('customers').update(toColumns(input)).eq('id', id).eq('tenant_id', tenantId).select(COLUMNS).maybeSingle();
  if (error) throw new DataError();
  return data ? toCustomer(data as Row) : null;
}

export async function getRetentionDaysWith(client: DataClient): Promise<number> {
  const { data, error } = await client.from('tenant_defaults').select('retention_days').maybeSingle();
  if (error) throw new DataError();
  return safeRetentionDays((data as { retention_days?: unknown } | null)?.retention_days);
}

export async function listCustomerDocumentsWith(client: DataClient, customerId: string): Promise<CustomerDocument[]> {
  if (!UUID.test(customerId)) return [];
  const { data, error } = await client
    .from('jobs')
    .select('id, documents(id, type, number, status, doc_date)')
    .eq('customer_id', customerId);
  if (error) throw new DataError();
  const out: CustomerDocument[] = [];
  for (const job of (data ?? []) as { documents?: { id: string; type: string; number: string; status: string; doc_date: string }[] }[]) {
    for (const d of job.documents ?? []) out.push({ id: d.id, type: d.type, number: d.number, status: d.status, date: d.doc_date });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// ---------------------------------------------------------------- demo mode (in memory, dummy data)

const DAY_MS = 24 * 60 * 60 * 1000;
let demoStore: Customer[] | null = null;

function demoRows(): Customer[] {
  demoStore ??= demoCustomers.map((c) => ({
    id: c.id,
    name: c.name,
    addressLines: c.addressLines,
    postcode: c.postcode,
    email: c.email,
    phone: c.phone,
    lastActivityAt: new Date(Date.now() - (DEFAULT_RETENTION_DAYS - c.daysLeft) * DAY_MS).toISOString(),
    purgeAt: new Date(Date.now() + c.daysLeft * DAY_MS).toISOString(),
  }));
  return demoStore;
}

/** Test hook: forget demo edits. */
export function resetDemoCustomers(): void {
  demoStore = null;
}

export function demoExtend(id: string): Customer | null {
  const c = demoRows().find((x) => x.id === id);
  if (!c) return null;
  c.lastActivityAt = new Date().toISOString();
  c.purgeAt = new Date(Date.now() + DEFAULT_RETENTION_DAYS * DAY_MS).toISOString();
  return c;
}

export function demoErase(id: string): boolean {
  const rows = demoRows();
  const i = rows.findIndex((x) => x.id === id);
  if (i < 0) return false;
  rows.splice(i, 1);
  return true;
}

// ---------------------------------------------------------------- the functions the screens call

export async function ownerClient(): Promise<DataClient> {
  const jar = await cookies();
  const token = jar.get(accessCookieName())?.value;
  if (!token) throw new DataError();
  return anonClient(token) as unknown as DataClient;
}

export async function listCustomers(search?: string): Promise<Customer[]> {
  await requireSession();
  if (isDemo()) {
    const term = cleanSearch(search).toLowerCase();
    return [...demoRows()]
      .filter((c) => !term || `${c.name} ${c.postcode}`.toLowerCase().includes(term))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }
  return listCustomersWith(await ownerClient(), search);
}

export async function getCustomer(id: string): Promise<Customer | null> {
  await requireSession();
  if (isDemo()) return demoRows().find((c) => c.id === id) ?? null;
  return getCustomerWith(await ownerClient(), id);
}

export async function createCustomer(input: CustomerInput): Promise<Customer> {
  const s = await requireSession();
  if (isDemo()) {
    const c: Customer = {
      id: `demo-customer-${Date.now()}`,
      name: input.name,
      addressLines: input.addressLines,
      postcode: input.postcode,
      email: input.email,
      phone: input.phone,
      lastActivityAt: new Date().toISOString(),
      purgeAt: new Date(Date.now() + DEFAULT_RETENTION_DAYS * DAY_MS).toISOString(),
    };
    demoRows().push(c);
    return c;
  }
  return createCustomerWith(await ownerClient(), s.tenantId, input);
}

export async function updateCustomer(id: string, input: CustomerInput): Promise<Customer | null> {
  const s = await requireSession();
  if (isDemo()) {
    const c = demoRows().find((x) => x.id === id);
    if (!c) return null;
    Object.assign(c, { name: input.name, addressLines: input.addressLines, postcode: input.postcode, email: input.email, phone: input.phone });
    return c;
  }
  return updateCustomerWith(await ownerClient(), s.tenantId, id, input);
}

export async function getRetentionDays(): Promise<number> {
  await requireSession();
  if (isDemo()) return DEFAULT_RETENTION_DAYS;
  return getRetentionDaysWith(await ownerClient());
}

export async function listCustomerDocuments(customerId: string): Promise<CustomerDocument[]> {
  await requireSession();
  if (isDemo()) {
    return [
      ...demoQuotes.filter((q) => q.customerId === customerId).map((q) => ({ id: q.id, type: 'quotation', number: q.quoteNumber, status: q.status === 'final' ? 'final' : 'draft', date: q.date })),
      ...demoGuaranteeRows().filter((g) => g.customerId === customerId).map((g) => ({ id: g.id, type: 'guarantee', number: g.number, status: g.status, date: g.docDate })),
    ].sort((a, b) => b.date.localeCompare(a.date));
  }
  return listCustomerDocumentsWith(await ownerClient(), customerId);
}
