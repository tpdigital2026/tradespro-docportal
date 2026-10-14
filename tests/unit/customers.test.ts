import { afterEach, describe, expect, it, vi } from 'vitest';

const sessionMock = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'staff' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock('../../src/lib/session', () => ({
  requireSession: async () => ({ userId: 'u1', tenantId: 't1', role: sessionMock.role, email: 'o@example.test', fullName: 'O', businessName: 'B' }),
}));
const stepUp = vi.hoisted(() => ({ fresh: false }));
vi.mock('../../src/lib/step-up-check', async () => {
  const real = await vi.importActual<typeof import('../../src/security/step-up')>('../../src/security/step-up');
  const check = await vi.importActual<typeof import('../../src/lib/step-up-check')>('../../src/lib/step-up-check');
  return {
    ...check,
    StepUpRequiredError: real.StepUpRequiredError,
    requireFreshStepUpForRequest: async () => {
      if (!stepUp.fresh) throw new real.StepUpRequiredError();
    },
  };
});

import { deleteCustomerAction, keepCustomerAction, createCustomerAction } from '../../src/app/(app)/customers/actions';
import {
  cleanSearch,
  createCustomerWith,
  getCustomerWith,
  getRetentionDaysWith,
  listCustomersWith,
  resetDemoCustomers,
  updateCustomerWith,
  type DataClient,
} from '../../src/lib/data/customers';
import { requireFreshStepUp } from '../../src/lib/step-up-check';
import { daysLeft, formatKeptUntil, isRunningOut, safeRetentionDays } from '../../src/lib/retention';
import { InMemoryStorage } from '../../src/lib/storage';
import { customerSchema, parseCustomerForm } from '../../src/lib/validation/customer';
import { StepUpRequiredError } from '../../src/security/step-up';

afterEach(() => {
  vi.unstubAllEnvs();
  sessionMock.role = 'owner';
  stepUp.fresh = false;
  resetDemoCustomers();
});

function form(o: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
}
const good = { name: '  Mr John Smith ', address1: '123 Bromley Road', address2: '', town: 'Bromley', postcode: 'br2  8bg', email: '', phone: '' };

describe('customerSchema and parseCustomerForm', () => {
  it('trims, upper-cases the postcode, drops empty address lines and turns empty optionals into null', () => {
    const r = parseCustomerForm(form(good));
    expect(r.ok && r.data).toEqual({ name: 'Mr John Smith', addressLines: ['123 Bromley Road', 'Bromley'], postcode: 'BR2 8BG', email: null, phone: null });
  });
  it('keeps a real email and phone', () => {
    const r = parseCustomerForm(form({ ...good, email: 'a@example.com', phone: '+44 7000 000000' }));
    expect(r.ok && [r.data.email, r.data.phone]).toEqual(['a@example.com', '+44 7000 000000']);
  });
  it('gives inline errors per field and hands the typed values back', () => {
    const r = parseCustomerForm(form({ name: '', address1: '', postcode: 'nope', email: 'x', phone: 'abc', address2: '', town: '' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['address1', 'email', 'name', 'phone', 'postcode']);
    expect(r.values.postcode).toBe('nope');
  });
  it('limits length and refuses control characters', () => {
    expect(parseCustomerForm(form({ ...good, name: 'x'.repeat(121) })).ok).toBe(false);
    expect(parseCustomerForm(form({ ...good, name: 'Bad\u0000name' })).ok).toBe(false);
    expect(customerSchema.safeParse({ ...good, addressLines: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
  });
});

describe('retention helpers', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  it('counts whole days left, rounded up, never negative', () => {
    expect(daysLeft('2026-10-15T11:00:00Z', now)).toBe(1);
    expect(daysLeft('2026-10-28T12:00:00Z', now)).toBe(14);
    expect(daysLeft('2026-10-01T12:00:00Z', now)).toBe(0);
    expect(daysLeft('garbage', now)).toBe(0);
  });
  it('warns at 14 days or fewer', () => {
    expect(isRunningOut(14)).toBe(true);
    expect(isRunningOut(15)).toBe(false);
  });
  it('only accepts retention values the database accepts', () => {
    expect([safeRetentionDays(30), safeRetentionDays(730), safeRetentionDays(29), safeRetentionDays(731), safeRetentionDays('90'), safeRetentionDays(null), safeRetentionDays(90.5)]).toEqual([30, 730, 90, 90, 90, 90, 90]);
  });
  it('formats the date in UK style', () => {
    expect(formatKeptUntil('2027-01-05T12:00:00Z')).toBe('5 January 2027');
  });
});

/** A thenable query builder that records the calls made on it. */
function stub(result: { data?: unknown; error?: unknown }) {
  const calls: [string, unknown[]][] = [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'eq', 'or', 'order', 'limit']) b[m] = (...a: unknown[]) => (calls.push([m, a]), b);
  b.maybeSingle = (...a: unknown[]) => (calls.push(['maybeSingle', a]), Promise.resolve({ data: result.data ?? null, error: result.error ?? null }));
  b.single = (...a: unknown[]) => (calls.push(['single', a]), Promise.resolve({ data: result.data ?? null, error: result.error ?? null }));
  b.then = (res: (v: unknown) => unknown) => res({ data: result.data ?? [], error: result.error ?? null });
  const tables: string[] = [];
  const client = { from: (t: string) => (tables.push(t), b) } as unknown as DataClient;
  return { client, calls, tables };
}
const row = { id: '11111111-1111-4111-8111-111111111111', name: 'A', address_lines: ['1 St'], postcode: 'AB1 2CD', email: null, phone: null, last_activity_at: '2026-10-01T00:00:00Z', purge_at: '2027-01-01T00:00:00Z' };
const input = { name: 'A', addressLines: ['1 St'], postcode: 'AB1 2CD', email: null, phone: null };

describe('customer data layer (stubbed client)', () => {
  it('lists most recent first and maps rows', async () => {
    const s = stub({ data: [row] });
    const list = await listCustomersWith(s.client);
    expect(list[0]).toMatchObject({ id: row.id, addressLines: ['1 St'], purgeAt: row.purge_at });
    expect(s.calls).toContainEqual(['order', ['last_activity_at', { ascending: false }]]);
  });
  it('search cannot inject filter syntax', async () => {
    expect(cleanSearch('a,b)(%_*"x\\')).toBe('a b x');
    const s = stub({ data: [] });
    await listCustomersWith(s.client, 'Smith,postcode.eq.AB1)');
    const or = s.calls.find((c) => c[0] === 'or');
    expect(or?.[1]).toEqual(['name.ilike.*Smith postcode.eq.AB1*,postcode.ilike.*Smith postcode.eq.AB1*']);
  });
  it('never asks the database about an id that is not a uuid', async () => {
    const s = stub({ data: row });
    expect(await getCustomerWith(s.client, 'not-a-uuid')).toBeNull();
    expect(await updateCustomerWith(s.client, 't1', "1' or '1'='1", input)).toBeNull();
    expect(s.tables).toEqual([]);
  });
  it('create sends the tenant from the caller and only the allowed columns', async () => {
    const s = stub({ data: row });
    await createCustomerWith(s.client, 't1', input);
    const ins = s.calls.find((c) => c[0] === 'insert')![1][0] as Record<string, unknown>;
    expect(Object.keys(ins).sort()).toEqual(['address_lines', 'email', 'name', 'phone', 'postcode', 'tenant_id']);
    expect(ins.tenant_id).toBe('t1');
  });
  it('update is scoped to the tenant as well as the row, and returns null when nothing matched', async () => {
    const s = stub({ data: null });
    expect(await updateCustomerWith(s.client, 't1', row.id, input)).toBeNull();
    expect(s.calls.filter((c) => c[0] === 'eq').map((c) => c[1])).toEqual([['id', row.id], ['tenant_id', 't1']]);
  });
  it('a database error becomes a generic error', async () => {
    await expect(listCustomersWith(stub({ error: { message: 'secret detail' } }).client)).rejects.toThrow('The request could not be completed');
  });
  it('reads the retention days, 90 when missing or out of range', async () => {
    expect(await getRetentionDaysWith(stub({ data: { retention_days: 120 } }).client)).toBe(120);
    expect(await getRetentionDaysWith(stub({ data: null }).client)).toBe(90);
    expect(await getRetentionDaysWith(stub({ data: { retention_days: 5 } }).client)).toBe(90);
  });
});

describe('requireFreshStepUp', () => {
  const now = 1_800_000_000;
  const api = (claims: unknown, error: unknown = null) => ({ getClaims: async () => ({ data: claims === null ? null : { claims }, error }) }) as never;
  it('passes with a code entered in the last 10 minutes', async () => {
    await expect(requireFreshStepUp('t', api({ amr: [{ method: 'otp', timestamp: now - 60 }] }), now)).resolves.toBeUndefined();
  });
  it('refuses an old code, no token, a verification error and a throwing client', async () => {
    await expect(requireFreshStepUp('t', api({ amr: [{ method: 'otp', timestamp: now - 3600 }] }), now)).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(requireFreshStepUp(undefined, api({}), now)).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(requireFreshStepUp('t', api(null, new Error('bad signature')), now)).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(requireFreshStepUp('t', { getClaims: async () => { throw new Error('boom'); } } as never, now)).rejects.toBeInstanceOf(StepUpRequiredError);
  });
});

describe('InMemoryStorage', () => {
  it('records deletions and can be made to fail once', async () => {
    const s = new InMemoryStorage();
    s.objects.add('a');
    await s.deleteStorageObjects(['a', 'missing']);
    expect(s.objects.size).toBe(0);
    expect(s.deleted).toEqual(['a', 'missing']);
    s.failNext = true;
    await expect(s.deleteStorageObjects(['b'])).rejects.toThrow();
    await expect(s.deleteStorageObjects(['b'])).resolves.toBeUndefined();
  });
});

describe('server actions', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('delete asks for a fresh code first and does not touch the database', async () => {
    vi.stubEnv('DEMO_MODE', '');
    expect(await deleteCustomerAction(id)).toEqual({ status: 'step-up' });
  });
  it('delete is owner only, checked before the step-up', async () => {
    sessionMock.role = 'staff';
    stepUp.fresh = true;
    const r = await deleteCustomerAction(id);
    expect(r.status).toBe('error');
  });
  it('delete refuses an id that is not a uuid', async () => {
    stepUp.fresh = true;
    expect((await deleteCustomerAction("1; drop table customers")).status).toBe('error');
  });
  it('in demo mode a fresh code lets the delete through and redirects', async () => {
    vi.stubEnv('DEMO_MODE', '1');
    stepUp.fresh = true;
    await expect(deleteCustomerAction('demo-customer-2')).rejects.toThrow('NEXT_REDIRECT /customers?deleted=1');
    expect((await deleteCustomerAction('demo-customer-2')).status).toBe('error');
  });
  it('keep resets the clock in demo mode and redirects back', async () => {
    vi.stubEnv('DEMO_MODE', '1');
    await expect(keepCustomerAction('demo-customer-2', {})).rejects.toThrow('NEXT_REDIRECT /customers/demo-customer-2?kept=1');
  });
  it('create returns inline errors without saving', async () => {
    const r = await createCustomerAction({}, form({ name: '', postcode: 'x' }));
    expect(r.errors?.name).toBeTruthy();
    expect(r.errors?.postcode).toBeTruthy();
  });
});
