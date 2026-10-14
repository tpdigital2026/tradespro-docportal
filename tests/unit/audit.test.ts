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

describe('assertNoPersonalData bypass attempts', () => {
  const rejected: [string, unknown][] = [
    ['toJSON', { toJSON: () => ({ email: 'a' }), safe: 1 }],
    ['email as a key', { 'ben@example.com': 1 }],
    ['customer.name', { customer: { name: 'x' } }],
    ['e-mail', { 'e-mail': 'x' }],
    ['firstname', { firstname: 'x' }],
    ['first_name camel', { firstName: 'x' }],
    ['surname', { surname: 'x' }],
    ['EMAILADDRESS', { EMAILADDRESS: 'x' }],
    ['emails', { emails: ['x'] }],
    ['tel', { tel: '1' }],
    ['telephone', { telephone: '1' }],
    ['phone_number', { phone_number: '1' }],
    ['recipient', { recipient: 'x' }],
    ['iban', { iban: 'x' }],
    ['file_name (fails closed)', { file_name: 'x' }],
    ['cyrillic lookalike key', { 'n\u0430me': 'x' }],
    ['phone value', { note: 'call 07700 900123' }],
    ['phone value with +44', { note: '+44 7700 900123' }],
    ['postcode value', { note: 'BR1 1AA' }],
    ['postcode value lowercase', { note: 'sw1a 1aa' }],
    ['bracketed phone', { note: '(07700) 900123' }],
    ['0044 phone', { note: '0044 7700 900123' }],
    ['+44 (0) phone', { note: '+44 (0)7700 900123' }],
    ['dotted phone', { note: '07700.900.123' }],
    ['full-width digit phone', { note: '０７７００ ９００１２３' }],
    ['full-width at sign email', { note: 'ben＠example.com' }],
    ['addr key', { addr: 'x' }],
    ['email in nested array', { list: [{ x: 'a@b.co' }] }],
  ];
  for (const [label, meta] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => assertNoPersonalData(meta)).toThrow(/personal/i);
    });
  }
  it('rejects cyclic objects', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => assertNoPersonalData(a)).toThrow(/serialised/i);
  });
  it('rejects values that do not serialise', () => {
    expect(() => assertNoPersonalData(undefined)).toThrow(/serialised/i);
    expect(() => assertNoPersonalData({ n: 10n })).toThrow(/serialised/i);
  });
  it('rejects 20,000-deep nesting', () => {
    let o: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i++) o = { a: o };
    expect(() => assertNoPersonalData(o)).toThrow();
  });
  it('rejects nesting deeper than 8', () => {
    let o: unknown = 1;
    for (let i = 0; i < 10; i++) o = { a: o };
    expect(() => assertNoPersonalData(o)).toThrow(/nested too deeply/i);
    let ok: unknown = 1;
    for (let i = 0; i < 7; i++) ok = { a: ok };
    expect(() => assertNoPersonalData(ok)).not.toThrow();
  });
  it('rejects oversized meta', () => {
    expect(() => assertNoPersonalData({ blob: 'x'.repeat(9000) })).toThrow(/too large/i);
  });
  it('does not reject ids, references, dates or amounts', () => {
    expect(() =>
      assertNoPersonalData({
        id: '3f0c2b9e-7a41-4e0d-9c55-0a1b2c3d4e5f',
        zero_id: '00000000-0000-0000-0000-000000000000',
        ref: 'QT-JS-001',
        number: 'INV-FJC-0042',
        date: '2026-10-14',
        at: '2026-01-04T10:30:00.000Z',
        total_pence: 900600,
        pence_text: '900600',
        action: 'document.finalised',
        path: 'tenant/pdfs/QT-JS-001-v1.pdf',
      }),
    ).not.toThrow();
  });
});

describe('writeAudit stores exactly what was checked', () => {
  it('uses one serialisation even if a getter or toJSON changes between calls', async () => {
    let n = 0;
    const meta = { get a() { n += 1; return n === 1 ? 'fine' : 'ben@example.com'; } };
    let m = 0;
    const meta2 = { toJSON: () => { m += 1; return m === 1 ? { ok: 1 } : { email: 'x@y.co' }; } };
    for (const object of [meta, meta2]) {
      const calls: { params?: unknown[] }[] = [];
      const db = { query: async (_s: string, params?: unknown[]) => (calls.push({ params }), { rows: [] }) };
      await writeAudit(db, { tenantId: 't', userId: 'u', action: 'x', meta: object as never });
      const stored = String(calls[0].params![8]);
      expect(stored).not.toMatch(/@/);
      expect(['{"a":"fine"}', '{"ok":1}']).toContain(stored);
    }
  });
  it('assertNoPersonalData returns the checked JSON', () => {
    expect(assertNoPersonalData({ a: 1 })).toBe('{"a":1}');
  });
});

describe('writeAudit top-level fields', () => {
  it('rejects an email in entityId, entity or action', async () => {
    const db = { query: async () => ({ rows: [] }) };
    await expect(writeAudit(db, { tenantId: 't', userId: 'u', action: 'x', entityId: 'ben@example.com' })).rejects.toThrow(/personal/i);
    await expect(writeAudit(db, { tenantId: 't', userId: 'u', action: 'x', entity: 'BR1 1AA' })).rejects.toThrow(/personal/i);
    await expect(writeAudit(db, { tenantId: 't', userId: 'u', action: '07700 900123' })).rejects.toThrow(/personal/i);
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
