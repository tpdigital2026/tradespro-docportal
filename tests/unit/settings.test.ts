import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMock = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'staff' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }, useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('../../src/lib/session', () => ({
  requireSession: async () => ({ userId: 'u1', tenantId: 't1', role: sessionMock.role, email: 'o@example.test', fullName: 'O', businessName: 'B' }),
}));
const stepUp = vi.hoisted(() => ({ fresh: false, calls: 0 }));
vi.mock('../../src/lib/step-up-check', async () => {
  const real = await vi.importActual<typeof import('../../src/security/step-up')>('../../src/security/step-up');
  return {
    StepUpRequiredError: real.StepUpRequiredError,
    requireFreshStepUpForRequest: async () => {
      stepUp.calls += 1;
      if (!stepUp.fresh) throw new real.StepUpRequiredError();
    },
  };
});

import {
  addBankAccountAction,
  archiveBankAccountAction,
  removeSignatureAction,
  renameBankAccountAction,
  setDefaultBankAccountAction,
  setPaymentWordingAction,
  setRetentionAction,
  setSessionPolicyAction,
  setSignatureConsentAction,
} from '../../src/app/(app)/settings/actions';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SettingsPage, { metadata } from '../../src/app/(app)/settings/page';
import { bankLabel, demoBankOptions, demoSettings, demoSettingsView, demoSignatureForDocuments, demoWordingForDocuments, getSettingsWith, resetDemoSettings } from '../../src/lib/data/settings';
import { paymentWordingOf } from '../../src/lib/payment-wording';
import { FJC_WORDING } from '../../src/db/wording';
import { normaliseAccountNumber, normaliseSortCode } from '../../src/security/bank-crypto';
import { ACCOUNT_NUMBER_ERROR, parseBankAccount, parseBankNames, retentionSchema, sessionPolicySchema, SORT_CODE_ERROR } from '../../src/lib/validation/settings';

function prng(seed: number) {
  let s = seed;
  const next = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, int };
}
const digits = (r: ReturnType<typeof prng>, n: number) => Array.from({ length: n }, () => String(r.int(0, 9))).join('');
/** Puts spaces and hyphens between digits at random. */
const sprinkle = (r: ReturnType<typeof prng>, d: string, seps: string[]) => [...d].map((c, i) => (i > 0 && r.next() < 0.4 ? seps[r.int(0, seps.length - 1)] : '') + c).join('');

const good = { accountName: 'FJC Roofing Ltd', bankName: 'Barclays', sortCode: '20-00-00', accountNumber: '12345678' };

describe('bank number validators (property tests)', () => {
  it('any 6 digits with spaces or hyphens between them normalise to NN-NN-NN of the same digits', () => {
    const r = prng(3);
    for (let i = 0; i < 400; i += 1) {
      const d = digits(r, 6);
      expect(normaliseSortCode(sprinkle(r, d, [' ', '-']))).toBe(`${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}`);
    }
  });
  it('any other length, or any letter, dot, slash or full-width digit, is refused', () => {
    const r = prng(5);
    for (let i = 0; i < 400; i += 1) {
      const n = [0, 1, 2, 3, 4, 5, 7, 8, 9, 12][r.int(0, 9)];
      expect(() => normaliseSortCode(digits(r, n))).toThrow();
      const d = digits(r, 6);
      const at = r.int(0, 6);
      const junk = ['a', '.', '/', '１', '_', '+', 'O'][r.int(0, 6)];
      expect(() => normaliseSortCode(d.slice(0, at) + junk + d.slice(at))).toThrow();
    }
  });
  it('account numbers: exactly 8 digits (spaces allowed between) and nothing else', () => {
    const r = prng(7);
    for (let i = 0; i < 400; i += 1) {
      const d = digits(r, 8);
      expect(normaliseAccountNumber(sprinkle(r, d, [' ']))).toBe(d);
      expect(() => normaliseAccountNumber(digits(r, [6, 7, 9, 10][r.int(0, 3)]))).toThrow();
      expect(() => normaliseAccountNumber(`${d.slice(0, 4)}x${d.slice(4)}`)).toThrow();
    }
  });
  it('the form parser agrees with the normalisers, and only ever returns normalised numbers', () => {
    const r = prng(11);
    for (let i = 0; i < 300; i += 1) {
      const sc = digits(r, 6);
      const an = digits(r, 8);
      const p = parseBankAccount({ ...good, sortCode: sprinkle(r, sc, [' ', '-']), accountNumber: sprinkle(r, an, [' ', '-']) });
      expect(p.ok).toBe(true);
      if (p.ok) {
        expect(p.value.sortCode).toMatch(/^\d{2}-\d{2}-\d{2}$/);
        expect(p.value.accountNumber).toBe(an);
      }
    }
  });
});

describe('parseBankAccount', () => {
  it('gives one plain message per field', () => {
    const p = parseBankAccount({ accountName: '  ', bankName: 'x'.repeat(61), sortCode: '12345', accountNumber: '1234567' });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.errors).toEqual({ accountName: 'Enter the account name', bankName: 'Keep the bank name to 60 characters or fewer', sortCode: SORT_CODE_ERROR, accountNumber: ACCOUNT_NUMBER_ERROR });
  });
  it('the bank name is optional, names are tidied, odd characters refused, non-strings never crash', () => {
    const p = parseBankAccount({ ...good, bankName: '', accountName: '  FJC   Roofing  Ltd ' });
    expect(p.ok && p.value).toMatchObject({ accountName: 'FJC Roofing Ltd', bankName: '' });
    expect(parseBankNames({ accountName: '<script>' }).ok).toBe(false);
    expect(parseBankAccount({ accountName: 5, sortCode: {}, accountNumber: null } as never).ok).toBe(false);
    expect(parseBankAccount({ ...good, sortCode: '1'.repeat(30) }).ok).toBe(false);
  });
  it('retention 30 to 730 and the session limits are whole numbers in range', () => {
    expect(retentionSchema.safeParse({ days: '90' }).success).toBe(true);
    for (const days of ['29', '731', '9.5', 'abc', '', -1]) expect(retentionSchema.safeParse({ days }).success, String(days)).toBe(false);
    expect(sessionPolicySchema.safeParse({ idleMinutes: '10', maxDays: '30' }).success).toBe(true);
    expect(sessionPolicySchema.safeParse({ idleMinutes: '480', maxDays: '1' }).success).toBe(true);
    expect(sessionPolicySchema.safeParse({ idleMinutes: '9', maxDays: '7' }).success).toBe(false);
    expect(sessionPolicySchema.safeParse({ idleMinutes: '30', maxDays: '31' }).success).toBe(false);
  });
  it('labels show the last four digits and nothing more, without an empty bank', () => {
    expect(bankLabel({ accountName: 'A', bankName: '', last4: '5678' })).toBe('A, ending 5678');
    expect(bankLabel({ accountName: 'A', bankName: 'B', last4: '5678' })).toBe('A, B, ending 5678');
  });
});

describe('settings actions', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('NODE_ENV', 'development');
    resetDemoSettings();
    sessionMock.role = 'owner';
    stepUp.fresh = false;
    stepUp.calls = 0;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('staff are refused everything, before any code is asked for', async () => {
    sessionMock.role = 'staff';
    stepUp.fresh = true;
    for (const r of [
      await addBankAccountAction(good),
      await renameBankAccountAction('demo-bank-main', { accountName: 'X' }),
      await setDefaultBankAccountAction('demo-bank-second'),
      await archiveBankAccountAction('demo-bank-main'),
      await setRetentionAction({ days: '60' }),
      await setPaymentWordingAction(paymentWordingOf(FJC_WORDING)),
      await setSessionPolicyAction({ idleMinutes: '15', maxDays: '3' }),
      await setSignatureConsentAction(false),
      await removeSignatureAction(),
    ]) {
      expect(r).toEqual({ status: 'error', message: 'Only the owner can change this.' });
    }
    expect(stepUp.calls).toBe(0);
    expect(demoSettings().accounts).toHaveLength(2);
  });

  it('checks what was typed first, then asks for a fresh code, then saves; the numbers never come back', async () => {
    expect(await addBankAccountAction({ ...good, sortCode: '1' })).toMatchObject({ status: 'invalid', errors: { sortCode: SORT_CODE_ERROR } });
    expect(stepUp.calls).toBe(0);
    expect(await addBankAccountAction(good)).toEqual({ status: 'step-up' });
    expect(demoSettings().accounts).toHaveLength(2);
    stepUp.fresh = true;
    const r = await addBankAccountAction(good);
    expect(r).toEqual({ status: 'ok', message: 'FJC Roofing Ltd, Barclays, ending 5678 is saved.' });
    expect(JSON.stringify(r)).not.toContain('12345678');
    expect(JSON.stringify(demoSettings())).not.toContain('12345678');
    expect(JSON.stringify(demoSettings())).not.toContain('20-00-00');
  });

  it('default, rename and archive need a fresh code; archiving the default promotes another', async () => {
    expect(await setDefaultBankAccountAction('demo-bank-second')).toEqual({ status: 'step-up' });
    stepUp.fresh = true;
    expect((await setDefaultBankAccountAction('demo-bank-second')).status).toBe('ok');
    expect(demoBankOptions()[0].id).toBe('demo-bank-second');
    expect((await renameBankAccountAction('demo-bank-second', { accountName: 'Main', bankName: '' })).status).toBe('ok');
    expect(demoBankOptions()[0].label).toBe('Main, ending 1111');
    const a = await archiveBankAccountAction('demo-bank-second');
    expect(a.status === 'ok' && a.message).toMatch(/oldest other account is now the default/);
    expect(demoBankOptions().map((o) => [o.id, o.isDefault])).toEqual([['demo-bank-main', true]]);
    expect(await archiveBankAccountAction("1'; drop table x")).toMatchObject({ status: 'error' });
  });

  it('retention and the session policy are owner only, checked, and need a fresh code', async () => {
    expect(await setRetentionAction({ days: '20' })).toMatchObject({ status: 'invalid' });
    expect(await setRetentionAction({ days: '60' })).toEqual({ status: 'step-up' });
    stepUp.fresh = true;
    const lower = await setRetentionAction({ days: '60' });
    expect(lower).toEqual({ status: 'ok', message: 'Customer data is now kept for 60 days after the last activity. Customers already on file keep their current deletion date until something happens on their record.' });
    expect(demoSettingsView().retentionDays).toBe(60);
    const higher = await setRetentionAction({ days: '365' });
    expect(higher.status === 'ok' && higher.message).toMatch(/Customers already on file get the longer time too\.$/);
    expect(await setSessionPolicyAction({ idleMinutes: '5', maxDays: '7' })).toMatchObject({ status: 'invalid', errors: { idleMinutes: expect.any(String) } });
    expect((await setSessionPolicyAction({ idleMinutes: '15', maxDays: '3' })).status).toBe('ok');
    expect(demoSettingsView().session).toEqual({ idleMinutes: 15, maxDays: 3 });
  });

  it('payment wording is owner only, checked first, needs a fresh code, then reaches the documents the demo makes', async () => {
    const typed = { ...paymentWordingOf(FJC_WORDING), depositDueLabel: 'On acceptance', paymentReference: 'invoice_number' as const };
    expect(await setPaymentWordingAction({ ...typed, balanceTerms: '' })).toMatchObject({ status: 'invalid', errors: { balanceTerms: expect.any(String) } });
    expect(await setPaymentWordingAction({ ...typed, depositTerms: 'Pay {amount}.' })).toMatchObject({ status: 'invalid', errors: { depositTerms: expect.stringMatching(/curly/) } });
    expect(stepUp.calls).toBe(0);
    expect(await setPaymentWordingAction(typed)).toEqual({ status: 'step-up' });
    expect(demoSettingsView().paymentWording.depositDueLabel).toBe('Before works start');
    stepUp.fresh = true;
    const r = await setPaymentWordingAction(typed);
    expect(r.status === 'ok' && r.message).toMatch(/Invoices you finalise from now on use this wording/);
    expect(demoSettingsView().paymentWording).toMatchObject({ depositDueLabel: 'On acceptance', paymentReference: 'invoice_number' });
    expect(demoWordingForDocuments().deposit_invoice.dueLabel).toBe('On acceptance');
    expect(demoWordingForDocuments().paymentReference).toBe('invoice_number');
    expect(FJC_WORDING.deposit_invoice.dueLabel).toBe('Before works start');
    const same = await setPaymentWordingAction(typed);
    expect(same.status === 'ok' && same.message).toBe('Nothing was different, so nothing changed.');
  });

  it('printing the signature needs a picture and a fresh code to switch on; switching off needs neither', async () => {
    stepUp.fresh = true;
    expect(await setSignatureConsentAction(true)).toEqual({ status: 'error', message: 'Add a picture of your signature first.' });
    demoSettings().signature = { png: Buffer.from('png'), width: 10, height: 5 };
    stepUp.fresh = false;
    expect(await setSignatureConsentAction(true)).toEqual({ status: 'step-up' });
    expect(demoSignatureForDocuments()).toBeNull();
    stepUp.fresh = true;
    expect((await setSignatureConsentAction(true)).status).toBe('ok');
    expect(demoSignatureForDocuments()).toMatch(/^data:image\/png;base64,/);
    stepUp.fresh = false;
    stepUp.calls = 0;
    expect((await setSignatureConsentAction(false)).status).toBe('ok');
    expect(demoSignatureForDocuments()).toBeNull();
    expect((await removeSignatureAction()).status).toBe('ok');
    expect(stepUp.calls).toBe(0);
    expect(demoSettingsView().signature).toEqual({ consent: false, hasImage: false });
  });
});

describe('getSettingsWith (the signed-in session, safe columns only)', () => {
  it('reads business details, accounts (last four only), retention, limits and signature state', async () => {
    const asked: Record<string, string> = {};
    const rows: Record<string, unknown> = {
      tenants: { name: 'FJC', company_number: '1', vat_registered: false, vat_number: 'GB 1', phone: '', email: 'a@b.c', website: '', address_lines: ['1 Road'], postcode: 'ME3 9UD', owner_name: 'Ben', owner_title: 'Director' },
      bank_accounts: [{ id: 'b1', account_name: 'A', bank_name: '', last4: '1234', is_default: true, archived_at: null }, { id: 'b2', account_name: 'Old', bank_name: 'X', last4: '9999', is_default: false, archived_at: '2026-01-01' }],
      tenant_defaults: { retention_days: 120, idle_logout_minutes: 15, max_session_days: 3, signature_consent: true },
      brand_assets: [{ id: 's1' }],
    };
    const chain = (t: string) => {
      const b: Record<string, unknown> = {
        select: (cols: string) => ((asked[t] = cols), b),
        order: () => b,
        eq: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: rows[t], error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows[t], error: null }).then(res),
      };
      return b;
    };
    const v = await getSettingsWith({ from: chain });
    expect(asked.bank_accounts).not.toMatch(/_enc/);
    expect(v.business).toMatchObject({ name: 'FJC', vatNumber: '', addressLines: ['1 Road'], postcode: 'ME3 9UD' });
    expect(v.bankAccounts.map((a) => [a.id, a.isDefault, a.archived])).toEqual([['b1', true, false], ['b2', false, true]]);
    expect(v).toMatchObject({ retentionDays: 120, session: { idleMinutes: 15, maxDays: 3 }, signature: { consent: true, hasImage: true } });
    // The stored payment wording is read too; with none stored the agreed wording is shown.
    expect(asked.tenant_defaults).toMatch(/\bterms\b/);
    expect(v.paymentWording).toEqual(paymentWordingOf(FJC_WORDING));
  });
});

describe('the Settings page', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('NODE_ENV', 'development');
    resetDemoSettings();
  });
  afterEach(() => vi.unstubAllEnvs());
  const html = async () => renderToStaticMarkup(createElement('div', null, await SettingsPage()));

  it('has its own title and one h1; owners get the controls', async () => {
    sessionMock.role = 'owner';
    expect(metadata.title).toBe('Settings');
    const out = await html();
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('Add a bank account');
    expect(out).toContain('Change how long customer data is kept');
    expect(out).toContain('Change the payment wording');
    expect(out).toContain('Before works start');
    expect(out).toContain('To change these, contact TradesPro Digital.');
    expect(out).toContain('ending </span>0000');
  });
  it('staff see read-only summaries: no controls, never more than the last four digits', async () => {
    sessionMock.role = 'staff';
    const out = await html();
    expect(out).toContain('Only the owner can change these settings.');
    for (const control of ['Add a bank account', 'Make default', 'Rename', 'Archive', 'Change how long', 'Change the payment wording', 'Change when people', 'Add a picture of your signature</label>', 'Delete the picture']) expect(out).not.toContain(control);
    expect(out).toMatch(/role="switch"[^>]*disabled=""/);
  });
});
