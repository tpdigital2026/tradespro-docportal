import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock('../../src/lib/session', () => ({
  requireSession: async () => ({ userId: 'u1', tenantId: 't1', role: 'owner', email: 'o@example.test', fullName: 'O', businessName: 'B' }),
}));

import { createCustomerAction, updateCustomerAction } from '../../src/app/(app)/customers/actions';
import { customerSavedUrl, SAVED_TEXT, savedKindFrom } from '../../src/lib/customer-flash';
import { resetDemoCustomers } from '../../src/lib/data/customers';

const form = (o: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ name: 'Mr Test Customer', address1: '1 Test Road', postcode: 'BR2 8BG', ...o })) f.set(k, v);
  return f;
};

beforeEach(() => {
  vi.stubEnv('DEMO_MODE', '1');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('VERCEL', '');
  resetDemoCustomers();
});

describe('saving a customer shows that it saved', () => {
  it('editing sends the person to the customer with an "updated" confirmation', async () => {
    await expect(updateCustomerAction('demo-customer-1', {}, form({ name: 'Mr John Smith' }))).rejects.toThrow('NEXT_REDIRECT /customers/demo-customer-1?saved=updated');
  });
  it('adding sends the person to the new customer with a "created" confirmation', async () => {
    await expect(createCustomerAction({}, form())).rejects.toThrow(/NEXT_REDIRECT \/customers\/[^?]+\?saved=created$/);
  });
  it('a failed edit stays on the form with the errors, and keeps what was typed', async () => {
    const r = await updateCustomerAction('demo-customer-1', {}, form({ name: '', postcode: 'x' }));
    expect(r.errors?.name).toBeTruthy();
    expect(r.errors?.postcode).toBeTruthy();
    expect(r.values?.address1).toBe('1 Test Road');
  });
  it('a customer that cannot be found says so on the form, not silently', async () => {
    const r = await updateCustomerAction('demo-customer-999', {}, form());
    expect(r.message).toBeTruthy();
  });
  it('an id that is not an id never reaches the data layer', async () => {
    const r = await updateCustomerAction('../etc', {}, form());
    expect(r.message).toBeTruthy();
  });
});

describe('the confirmation', () => {
  it('url and reading it back agree; the old flag still works; junk shows nothing', () => {
    expect(customerSavedUrl('abc', 'updated')).toBe('/customers/abc?saved=updated');
    expect(savedKindFrom('updated')).toBe('updated');
    expect(savedKindFrom('created')).toBe('created');
    expect(savedKindFrom('1')).toBe('updated');
    expect(savedKindFrom(['created', 'x'])).toBe('created');
    for (const v of [undefined, '', 'yes', '0', '<b>']) expect(savedKindFrom(v)).toBeNull();
  });
  it('says Saved, and has no em dash', () => {
    for (const t of Object.values(SAVED_TEXT)) {
      expect(t).toMatch(/^Saved\./);
      expect(t).not.toMatch(/\u2014/);
    }
  });
});
