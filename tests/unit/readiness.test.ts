import { describe, expect, it } from 'vitest';
import { FJC_WORDING } from '../../src/db/wording';
import { FJC_OLD_DEPOSIT_TERMS } from '../../src/db/seed-fjc';
import type { BusinessFacts } from '../../src/lib/documents/map';
import { readinessChecks } from '../../src/lib/readiness/check';
import { fakeTenant } from '../fixtures/fake';

const TODAY = '2026-10-20';
const biz = (over: Partial<BusinessFacts> = {}): BusinessFacts => ({ tenant: fakeTenant, wording: FJC_WORDING, disclaimer: '', validityDays: 30, vatRateBp: 2000, ...over });

describe('readiness of a business set up by TradesPro', () => {
  it('with the FJC wording, no document type asks for set-up: quotation, deposit and balance invoice, receipt, guarantee, survey', () => {
    const r = readinessChecks(biz(), [], TODAY);
    expect(r.map((i) => i.name)).toEqual(['quotation', 'deposit invoice', 'balance invoice', 'receipt', 'guarantee', 'survey report']);
    expect(r.filter((i) => !i.ok)).toEqual([]);
  });
  it('wording stored before the Due line, payment reference and {balance} existed still never asks for set-up', () => {
    const old = structuredClone(FJC_WORDING);
    delete (old.balance_invoice as { dueLabel?: string }).dueLabel;
    delete old.paymentReference;
    old.deposit_invoice.terms = FJC_OLD_DEPOSIT_TERMS;
    expect(readinessChecks(biz({ wording: old }), [], TODAY).every((i) => i.ok)).toBe(true);
  });
  it('fails, and says which line, when wording or the brand is missing', () => {
    const r = readinessChecks(biz({ wording: null }), ['Your logo is not set up yet. Contact TradesPro Digital to add it.'], TODAY);
    expect(r.every((i) => !i.ok)).toBe(true);
    expect(r[0].setUpLines.join(' ')).toMatch(/quotation terms are not set up/);
  });
});
