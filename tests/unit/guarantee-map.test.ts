import { describe, expect, it } from 'vitest';
import { FJC_WORDING } from '../../src/db/wording';
import type { BusinessFacts } from '../../src/lib/documents/map';
import { mapGuarantee, type GuaranteeFacts } from '../../src/lib/guarantee/map';
import { emptyGuarantee, type GuaranteeValues } from '../../src/lib/guarantee/model';
import { fakeTenant } from '../fixtures/fake';

const TODAY = '2026-10-19';
const business = (over: Partial<BusinessFacts> = {}): BusinessFacts => ({ tenant: fakeTenant, wording: FJC_WORDING, disclaimer: '', validityDays: 30, vatRateBp: 2000, ...over });
const values = (over: Partial<GuaranteeValues> = {}): GuaranteeValues => emptyGuarantee({ roofType: 'tiled', years: '25', address: '5 Sample Road, Anytown', completedOn: '2026-10-12', ...over });
const facts = (v: GuaranteeValues | null): GuaranteeFacts => ({ number: 'GC-Q-1', jobReference: 'Q-1', customerName: 'Sample Customer', values: v });

describe('mapGuarantee', () => {
  it('puts the owner’s facts and the business’s own wording into the template input', () => {
    const r = mapGuarantee(facts(values()), business(), TODAY);
    expect(r).toEqual({
      ok: true,
      input: {
        certificateNo: 'GC-Q-1',
        years: 25,
        workDescription: 'tiled roof',
        address: '5 Sample Road, Anytown',
        completedLabel: '12/10/2026',
        statement: FJC_WORDING.guarantee.statement,
        disclaimerLine: FJC_WORDING.guarantee.disclaimerLine,
      },
    });
  });

  it('uses the other roof as typed', () => {
    const r = mapGuarantee(facts(values({ roofType: 'other', roofOther: 'garage roof' })), business(), TODAY);
    expect(r.ok && r.input.workDescription).toBe('garage roof');
  });

  it('leaves the disclaimer out when the business has none', () => {
    const wording = { ...FJC_WORDING, guarantee: { statement: FJC_WORDING.guarantee.statement, disclaimerLine: null } };
    const r = mapGuarantee(facts(values()), business({ wording }), TODAY);
    expect(r.ok && r.input.disclaimerLine).toBeNull();
  });

  it('is blocked, with a plain message for each gap, until everything is on record', () => {
    const r = mapGuarantee(facts(values({ years: '', completedOn: '' })), business(), TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing.join(' ')).toMatch(/how many years[\s\S]*date the installation was completed/);
  });

  it('refuses a completion date in the future, the day it is checked', () => {
    expect(mapGuarantee(facts(values({ completedOn: '2026-10-20' })), business(), TODAY).ok).toBe(false);
    expect(mapGuarantee(facts(values({ completedOn: '2026-10-20' })), business(), '2026-10-20').ok).toBe(true);
  });

  it('never invents wording: without the business’s own guarantee wording it is blocked', () => {
    const r = mapGuarantee(facts(values()), business({ wording: null }), TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing.join(' ')).toMatch(/guarantee wording is not set up/);
  });

  it('says so when the draft holds nothing readable', () => {
    const r = mapGuarantee(facts(null), business(), TODAY);
    expect(r.ok).toBe(false);
  });
});
