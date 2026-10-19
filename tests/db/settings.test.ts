import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  addBankAccountWith,
  archiveBankAccountWith,
  removeSignatureWith,
  renameBankAccountWith,
  saveSignatureWith,
  setDefaultBankAccountWith,
  setPaymentWordingWith,
  setRetentionWith,
  setSessionPolicyWith,
  setSignatureConsentWith,
  signaturePath,
} from '../../src/lib/data/settings';
import { FJC_WORDING, tenantWordingSchema } from '../../src/db/wording';
import { signatureWith } from '../../src/lib/documents/facts-sql';
import { paymentWordingOf } from '../../src/lib/payment-wording';
import { InMemoryStorage } from '../../src/lib/storage';
import { decryptBankDetails } from '../../src/security/bank-crypto';
import { connect } from '../../src/db/connect';
import { actAs, actAsServer, createTenantWithUser, dbAvailable, withRollback } from './helpers';

const nested = { nested: true } as const;
const KEY = randomBytes(32);
const acct = (n: string) => ({ accountName: `Account ${n}`, bankName: 'Test Bank', sortCode: '20-00-00', accountNumber: `1234567${n}` });

async function business(c: Client) {
  const t = await createTenantWithUser(c, `Set ${randomBytes(4).toString('hex')}`);
  await c.query(`insert into public.tenant_defaults (tenant_id) values ($1)`, [t.tenantId]);
  await c.query(`insert into public.brand_kits (tenant_id) values ($1)`, [t.tenantId]);
  return { ...t, actor: { tenantId: t.tenantId, userId: t.userId } };
}

async function expectFail(c: Client, sql: string, params: unknown[], re: RegExp) {
  await c.query('savepoint f');
  await expect(c.query(sql, params)).rejects.toThrow(re);
  await c.query('rollback to savepoint f');
}

describe.skipIf(!dbAvailable)('owner settings: bank accounts', () => {
  it('adds encrypted accounts bound to the business; only the last four are readable; the first is the default', async () => {
    await withRollback(async (c) => {
      const b = await business(c);
      const first = await addBankAccountWith(c, b.actor, acct('1'), KEY, nested);
      const second = await addBankAccountWith(c, b.actor, acct('2'), KEY, nested);
      expect(first).toMatchObject({ last4: '5671', isDefault: true });
      expect(second.isDefault).toBe(false);
      const row = (await c.query(`select * from public.bank_accounts where id = $1`, [first.id])).rows[0];
      expect(row.sort_code_enc).not.toContain('20');
      expect(row.account_number_enc).not.toContain('12345671');
      expect(decryptBankDetails(row, KEY, b.tenantId)).toEqual({ sortCode: '20-00-00', accountNumber: '12345671' });
      // Bound to this business: another tenant id cannot decrypt it.
      expect(() => decryptBankDetails(row, KEY, '00000000-0000-4000-8000-000000000000')).toThrow();
      const audit = await c.query(`select action, entity_id, meta::text from public.audit_log where tenant_id = $1 order by id`, [b.tenantId]);
      expect(audit.rows.map((r) => r.action)).toEqual(['bank.add', 'bank.add']);
      expect(JSON.stringify(audit.rows)).not.toMatch(/1234567|20-00-00|5671/);
      // The app role sees safe columns only and cannot write.
      await actAs(c, b.userId);
      expect((await c.query(`select last4 from public.bank_accounts order by last4`)).rows.map((r) => r.last4)).toEqual(['5671', '5672']);
      await expectFail(c, `select account_number_enc from public.bank_accounts`, [], /permission denied/);
      await expectFail(c, `update public.bank_accounts set account_name = 'x'`, [], /permission denied/);
    });
  });

  it('one default at a time; archive never deletes and promotes the oldest other account; renames keep numbers', async () => {
    await withRollback(async (c) => {
      const b = await business(c);
      const a1 = await addBankAccountWith(c, b.actor, acct('1'), KEY, nested);
      const a2 = await addBankAccountWith(c, b.actor, acct('2'), KEY, nested);
      const a3 = await addBankAccountWith(c, b.actor, acct('3'), KEY, nested);
      // Distinct creation times (inside one test transaction now() is the same for every row).
      for (const [id, ago] of [[a1.id, 3], [a2.id, 2], [a3.id, 1]] as const) await c.query(`update public.bank_accounts set created_at = now() - make_interval(hours => $2) where id = $1`, [id, ago]);
      await setDefaultBankAccountWith(c, b.actor, a3.id, nested);
      const defaults = async () => (await c.query(`select id from public.bank_accounts where tenant_id = $1 and is_default and archived_at is null`, [b.tenantId])).rows.map((r) => r.id);
      expect(await defaults()).toEqual([a3.id]);
      expect(await archiveBankAccountWith(c, b.actor, a3.id, nested)).toEqual({ newDefaultId: a1.id });
      expect(await defaults()).toEqual([a1.id]);
      expect((await c.query(`select archived_at from public.bank_accounts where id = $1`, [a3.id])).rows[0].archived_at).not.toBeNull();
      await expect(setDefaultBankAccountWith(c, b.actor, a3.id, nested)).rejects.toMatchObject({ code: 'not_found' });
      expect(await archiveBankAccountWith(c, b.actor, a2.id, nested)).toEqual({ newDefaultId: null });
      const before = (await c.query(`select account_number_enc from public.bank_accounts where id = $1`, [a1.id])).rows[0].account_number_enc;
      await renameBankAccountWith(c, b.actor, a1.id, { accountName: 'Main', bankName: '' }, nested);
      const after = (await c.query(`select account_name, bank_name, account_number_enc from public.bank_accounts where id = $1`, [a1.id])).rows[0];
      expect(after).toEqual({ account_name: 'Main', bank_name: '', account_number_enc: before });
    });
  });

  it('never touches another business\'s accounts, and caps active accounts at ten', async () => {
    await withRollback(async (c) => {
      const a = await business(c);
      const b = await business(c);
      const theirs = await addBankAccountWith(c, b.actor, acct('1'), KEY, nested);
      await expect(setDefaultBankAccountWith(c, a.actor, theirs.id, nested)).rejects.toMatchObject({ code: 'not_found' });
      await expect(archiveBankAccountWith(c, a.actor, theirs.id, nested)).rejects.toMatchObject({ code: 'not_found' });
      await expect(renameBankAccountWith(c, a.actor, theirs.id, { accountName: 'Hijack', bankName: '' }, nested)).rejects.toMatchObject({ code: 'not_found' });
      for (let i = 0; i < 10; i += 1) await addBankAccountWith(c, a.actor, acct(String(i)), KEY, nested);
      await expect(addBankAccountWith(c, a.actor, acct('9'), KEY, nested)).rejects.toMatchObject({ code: 'limit' });
    });
  });
});

describe.skipIf(!dbAvailable)('owner settings: the account cap under concurrency', () => {
  it('two adds at the same moment with nine accounts: exactly one succeeds (committed data, cleaned up after)', async () => {
    const setup = await connect();
    let t: { tenantId: string; userId: string } | null = null;
    try {
      t = await createTenantWithUser(setup, `Cap ${randomBytes(4).toString('hex')}`);
      const actor = { tenantId: t.tenantId, userId: t.userId };
      for (let i = 0; i < 9; i += 1) await addBankAccountWith(setup, actor, acct(String(i)), KEY);
      const one = await connect();
      const two = await connect();
      try {
        const results = await Promise.allSettled([addBankAccountWith(one, actor, acct('8'), KEY), addBankAccountWith(two, actor, acct('9'), KEY)]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const bad = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(bad.reason).toMatchObject({ code: 'limit' });
        expect((await setup.query(`select count(*)::int n from public.bank_accounts where tenant_id = $1 and archived_at is null`, [t.tenantId])).rows[0].n).toBe(10);
      } finally {
        await one.end();
        await two.end();
      }
    } finally {
      if (t) {
        // Audit rows are append only and hold ids only; they stay.
        await setup.query(`delete from public.tenants where id = $1`, [t.tenantId]);
        await setup.query(`delete from auth.users where id = $1`, [t.userId]);
      }
      await setup.end();
    }
  });
});

describe.skipIf(!dbAvailable)('owner settings: retention, session policy, signature', () => {
  it('retention and the session limits are saved (upsert) and audited with values only', async () => {
    await withRollback(async (c) => {
      const b = await business(c);
      await c.query(`delete from public.tenant_defaults where tenant_id = $1`, [b.tenantId]);
      await setRetentionWith(c, b.actor, 365, nested);
      await setSessionPolicyWith(c, b.actor, { idleMinutes: 15, maxDays: 2 }, nested);
      const d = (await c.query(`select retention_days, idle_logout_minutes, max_session_days from public.tenant_defaults where tenant_id = $1`, [b.tenantId])).rows[0];
      expect(d).toEqual({ retention_days: 365, idle_logout_minutes: 15, max_session_days: 2 });
      const audit = await c.query(`select action, meta from public.audit_log where tenant_id = $1 order by id`, [b.tenantId]);
      expect(audit.rows).toEqual([{ action: 'settings.retention', meta: { days: 365, was: 90, extended: 0 } }, { action: 'settings.session', meta: { idle: 15, days: 2 } }]);
      await expect(setSessionPolicyWith(c, b.actor, { idleMinutes: 5, maxDays: 2 }, nested)).rejects.toThrow(/check constraint/);
      await expect(setSessionPolicyWith(c, b.actor, { idleMinutes: 30, maxDays: 31 }, nested)).rejects.toThrow(/check constraint/);
    });
  });

  it('raising retention gives customers already on file the longer time; lowering never shortens a date', async () => {
    await withRollback(async (c) => {
      const b = await business(c);
      const other = await business(c);
      const ins = `insert into public.customers (tenant_id, name, last_activity_at, purge_at) values ($1, $2, now() - interval '20 days', now() + interval '70 days') returning id`;
      const a1 = (await c.query(ins, [b.tenantId, 'A'])).rows[0].id;
      // Already further out than the new setting gives: must stay where it is.
      const far = (await c.query(`insert into public.customers (tenant_id, name, last_activity_at, purge_at) values ($1, 'Far', now() - interval '20 days', now() + interval '600 days') returning id`, [b.tenantId])).rows[0].id;
      const theirs = (await c.query(ins, [other.tenantId, 'Theirs'])).rows[0].id;
      const days = async (id: string) => Number((await c.query(`select round(extract(epoch from purge_at - now()) / 86400) d from public.customers where id = $1`, [id])).rows[0].d);
      expect(await setRetentionWith(c, b.actor, 365, nested)).toEqual({ previous: 90, extended: 1 });
      expect(await days(a1)).toBe(345);
      expect(await days(far)).toBe(600);
      expect(await days(theirs)).toBe(70);
      expect(await setRetentionWith(c, b.actor, 30, nested)).toEqual({ previous: 365, extended: 0 });
      expect(await days(a1)).toBe(345);
      const meta = (await c.query(`select meta from public.audit_log where tenant_id = $1 and action = 'settings.retention' order by id`, [b.tenantId])).rows.map((r) => r.meta);
      expect(meta).toEqual([{ days: 365, was: 90, extended: 1 }, { days: 30, was: 365, extended: 0 }]);
      // The function is for the server only.
      await actAs(c, b.userId);
      await expectFail(c, `select private.extend_purge_for_retention($1, 365)`, [b.tenantId], /permission denied/);
    });
  });

  it('the app role (even the owner) cannot change these settings or reset them, but can still change the others', async () => {
    await withRollback(async (c) => {
      const b = await business(c);
      await actAs(c, b.userId);
      const server = /only be changed by the server|only be removed by the server/;
      await expectFail(c, `update public.tenant_defaults set retention_days = 30 where tenant_id = $1`, [b.tenantId], server);
      await expectFail(c, `update public.tenant_defaults set idle_logout_minutes = 480 where tenant_id = $1`, [b.tenantId], server);
      await expectFail(c, `update public.tenant_defaults set max_session_days = 30 where tenant_id = $1`, [b.tenantId], server);
      await expectFail(c, `update public.tenant_defaults set signature_consent = true where tenant_id = $1`, [b.tenantId], server);
      await expectFail(c, `delete from public.tenant_defaults where tenant_id = $1`, [b.tenantId], server);
      expect((await c.query(`update public.tenant_defaults set vat_rate_bp = 500 where tenant_id = $1`, [b.tenantId])).rowCount).toBe(1);
      await actAsServer(c);
      await c.query(`delete from public.tenant_defaults where tenant_id = $1`, [b.tenantId]);
      await actAs(c, b.userId);
      await expectFail(c, `insert into public.tenant_defaults (tenant_id, idle_logout_minutes) values ($1, 480)`, [b.tenantId], server);
      expect((await c.query(`insert into public.tenant_defaults (tenant_id) values ($1)`, [b.tenantId])).rowCount).toBe(1);
    });
  });

  it('a signature row can only be written by the server', async () => {
    await withRollback(async (c) => {
      const b = await business(c);
      const kit = (await c.query(`select id from public.brand_kits where tenant_id = $1`, [b.tenantId])).rows[0].id;
      await actAs(c, b.userId);
      const ins = `insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, $3, $4) returning id`;
      await expectFail(c, ins, [b.tenantId, kit, 'signature', `${b.tenantId}/x.png`], /only be stored by the server/);
      // Other brand assets keep working for the owner.
      expect((await c.query(ins, [b.tenantId, kit, 'badge', `${b.tenantId}/b.png`])).rowCount).toBe(1);
      await actAsServer(c);
      const s = await c.query(ins, [b.tenantId, kit, 'signature', `${b.tenantId}/s.png`]);
      await actAs(c, b.userId);
      await expectFail(c, `update public.brand_assets set storage_path = $2 where id = $1`, [s.rows[0].id, `${b.tenantId}/t.png`], /only be stored by the server/);
      await expectFail(c, `delete from public.brand_assets where id = $1`, [s.rows[0].id], /only be stored by the server/);
    });
  });

  it('stores the picture (row and file together), replaces the old one, prints only with consent, and removes both', async () => {
    await withRollback(async (c) => {
      const b = await business(c);
      const st = new InMemoryStorage();
      await expect(setSignatureConsentWith(c, b.actor, true, nested)).rejects.toMatchObject({ code: 'invalid' });
      const one = await saveSignatureWith(c, st, b.actor, { png: Buffer.from('png-one'), width: 300, height: 100 }, nested);
      const two = await saveSignatureWith(c, st, b.actor, { png: Buffer.from('png-two'), width: 300, height: 100 }, nested);
      expect([...st.blobs.keys()]).toEqual([signaturePath(b.tenantId, two.id)]);
      expect((await c.query(`select id from public.brand_assets where tenant_id = $1 and kind = 'signature'`, [b.tenantId])).rows.map((r) => r.id)).toEqual([two.id]);
      expect(one.id).not.toBe(two.id);
      const read = (p: string) => st.get(p);
      expect(await signatureWith(c, b.tenantId, read)).toEqual({ uri: null, problem: null });
      await setSignatureConsentWith(c, b.actor, true, nested);
      const on = await signatureWith(c, b.tenantId, read);
      expect(on.uri).toBe(`data:image/png;base64,${Buffer.from('png-two').toString('base64')}`);
      const consent = (await c.query(`select signature_consent, signature_consent_by from public.tenant_defaults where tenant_id = $1`, [b.tenantId])).rows[0];
      expect(consent).toEqual({ signature_consent: true, signature_consent_by: b.userId });
      // A consented picture that cannot be read blocks the document (preview and final never differ).
      expect((await signatureWith(c, b.tenantId, async () => null)).problem).toMatch(/could not be read/);
      await removeSignatureWith(c, st, b.actor, nested);
      expect(st.blobs.size).toBe(0);
      expect(await signatureWith(c, b.tenantId, read)).toEqual({ uri: null, problem: null });
    });
  });

  it('a failed upload stores nothing; a refused database step deletes the uploaded file', async () => {
    await withRollback(async (c) => {
      const b = await business(c);
      const st = new InMemoryStorage();
      st.put = async () => { throw new Error('Storage upload failed'); };
      await expect(saveSignatureWith(c, st, b.actor, { png: Buffer.from('x'), width: 1, height: 1 }, nested)).rejects.toThrow();
      expect((await c.query(`select count(*)::int n from public.brand_assets where tenant_id = $1 and kind = 'signature'`, [b.tenantId])).rows[0].n).toBe(0);
      const ok = new InMemoryStorage();
      // An impossible size makes the insert fail after the upload: the file must go again.
      await expect(saveSignatureWith(c, ok, b.actor, { png: Buffer.from('x'), width: 3_000_000_000, height: 1 }, nested)).rejects.toThrow();
      expect(ok.blobs.size).toBe(0);
    });
  });
});

describe.skipIf(!dbAvailable)('owner settings: payment wording', () => {
  const typed = { ...paymentWordingOf(FJC_WORDING), depositDueLabel: 'On acceptance', balanceTerms: 'Pay within 7 days of this invoice.', paymentReference: 'invoice_number' as const };

  async function withWording(c: Client, wording: unknown) {
    const b = await business(c);
    await c.query(`update public.tenant_defaults set terms = $1::jsonb where tenant_id = $2`, [JSON.stringify(wording), b.tenantId]);
    return b;
  }

  it('saves the payment wording into the stored wording, leaves the rest alone, and audits the field names only', async () => {
    await withRollback(async (c) => {
      const b = await withWording(c, FJC_WORDING);
      const r = await setPaymentWordingWith(c, b.actor, typed, nested);
      expect(r.changed.sort()).toEqual(['balanceTerms', 'depositDueLabel', 'paymentReference']);
      const stored = tenantWordingSchema.parse((await c.query(`select terms from public.tenant_defaults where tenant_id = $1`, [b.tenantId])).rows[0].terms);
      expect(stored.deposit_invoice).toMatchObject({ dueLabel: 'On acceptance', balanceDueLabel: FJC_WORDING.deposit_invoice.balanceDueLabel });
      expect(stored.balance_invoice).toMatchObject({ terms: 'Pay within 7 days of this invoice.', dueLabel: 'On receipt' });
      expect(stored.paymentReference).toBe('invoice_number');
      expect(stored.quote).toEqual(FJC_WORDING.quote);
      expect(stored.guarantee).toEqual(FJC_WORDING.guarantee);
      const audit = await c.query(`select action, entity, meta::text from public.audit_log where tenant_id = $1`, [b.tenantId]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ action: 'settings.payment_wording', entity: 'tenant_defaults' });
      expect(audit.rows[0].meta).not.toMatch(/On acceptance|Pay within/);
    });
  });

  it('wording stored before the new fields existed gains them when the owner saves; saving the same thing again changes nothing', async () => {
    await withRollback(async (c) => {
      const { dueLabel: _d, ...balance } = FJC_WORDING.balance_invoice;
      const { paymentReference: _p, ...rest } = FJC_WORDING;
      const b = await withWording(c, { ...rest, balance_invoice: balance });
      const first = await setPaymentWordingWith(c, b.actor, paymentWordingOf(FJC_WORDING), nested);
      expect(first.changed.sort()).toEqual(['balanceDueLabel', 'paymentReference']);
      const again = await setPaymentWordingWith(c, b.actor, paymentWordingOf(FJC_WORDING), nested);
      expect(again.changed).toEqual([]);
      expect((await c.query(`select count(*)::int n from public.audit_log where tenant_id = $1`, [b.tenantId])).rows[0].n).toBe(1);
    });
  });

  it('refuses a business whose document wording has not been set up, and never touches another business', async () => {
    await withRollback(async (c) => {
      const empty = await business(c);
      await expect(setPaymentWordingWith(c, empty.actor, typed, nested)).rejects.toMatchObject({ code: 'not_configured' });
      const other = await withWording(c, FJC_WORDING);
      await setPaymentWordingWith(c, empty.actor, typed, nested).catch(() => undefined);
      const stored = (await c.query(`select terms from public.tenant_defaults where tenant_id = $1`, [other.tenantId])).rows[0].terms;
      expect(tenantWordingSchema.parse(stored)).toEqual(FJC_WORDING);
    });
  });
});
