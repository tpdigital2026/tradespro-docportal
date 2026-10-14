import { describe, expect, it } from 'vitest';
import { assertNoPersonalData, writeAudit } from '../../src/security/audit';

describe('assertNoPersonalData', () => {
  it('allows ids, counts and codes', () => {
    expect(() => assertNoPersonalData({ document_type: 'quotation', total_pence: 900600, customer_id: 'abc', last4: '1234' })).not.toThrow();
  });
  it('rejects personal keys at any depth', () => {
    for (const meta of [
      { name: 'x' }, { customer_name: 'x' }, { email: 'a' }, { phone: '1' }, { address: 'x' }, { postcode: 'x' },
      { sort_code: '1' }, { accountNumber: '1' }, { nested: { deep: [{ email_address: 'x' }] } },
    ]) {
      expect(() => assertNoPersonalData(meta), JSON.stringify(meta)).toThrow(/personal/i);
    }
  });
  it('rejects values that look like email addresses', () => {
    expect(() => assertNoPersonalData({ note: 'sent to ben@example.com' })).toThrow(/personal/i);
  });
});

describe('writeAudit', () => {
  it('inserts a row with the given fields', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const db = { query: async (sql: string, params?: unknown[]) => (calls.push({ sql, params }), { rows: [] }) };
    await writeAudit(db, { tenantId: 't', userId: 'u', action: 'document.finalised', entity: 'document', entityId: 'd1', meta: { type: 'quotation' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/insert into public\.audit_log/);
    expect(calls[0].params).toEqual(['t', 'u', null, 'document.finalised', 'document', 'd1', null, null, JSON.stringify({ type: 'quotation' })]);
  });
  it('refuses to write personal data and writes nothing', async () => {
    const calls: unknown[] = [];
    const db = { query: async () => (calls.push(1), { rows: [] }) };
    await expect(writeAudit(db, { tenantId: 't', userId: 'u', action: 'x', meta: { email: 'a@b.com' } })).rejects.toThrow(/personal/i);
    expect(calls).toHaveLength(0);
  });
});
