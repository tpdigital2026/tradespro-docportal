import { describe, expect, it } from 'vitest';
import { documentNumberFor } from '../../src/lib/job-stage';
import {
  defaultYearsText,
  emptyGuarantee,
  guaranteeErrors,
  nextCertificateSeq,
  parseGuaranteeInput,
  parseYears,
  roofKeyOf,
  roofLabel,
  roofWords,
  storedGuarantee,
  tidyGuarantee,
  type GuaranteeValues,
} from '../../src/lib/guarantee/model';

const TODAY = '2026-10-19';
const ok = (over: Partial<GuaranteeValues> = {}): GuaranteeValues => emptyGuarantee({ roofType: 'tiled', years: '25', address: '5 Sample Road, Anytown', completedOn: '2026-10-12', ...over });

describe('guarantee years', () => {
  it('start at 20 for flat and dormer flat roofs and 25 for tiled, and at nothing for any other roof', () => {
    expect(defaultYearsText('flat')).toBe('20');
    expect(defaultYearsText('dormer')).toBe('20');
    expect(defaultYearsText('tiled')).toBe('25');
    expect(defaultYearsText('pitched')).toBe('');
    expect(defaultYearsText('other')).toBe('');
    expect(defaultYearsText('')).toBe('');
  });

  it('are a whole number from 1 to 50', () => {
    for (const good of ['1', '10', '25', '50', '07']) expect(parseYears(good), good).not.toBeNull();
    for (const bad of ['', '0', '51', '99', '100', '2.5', '-5', 'ten', '1e1', ' ']) expect(parseYears(bad), bad).toBeNull();
    expect(parseYears(' 25 ')).toBe(25);
  });

  it('are required and range checked in the errors', () => {
    expect(guaranteeErrors(ok({ years: '' }), TODAY).years).toMatch(/how many years/);
    expect(guaranteeErrors(ok({ years: '0' }), TODAY).years).toMatch(/1 to 50/);
    expect(guaranteeErrors(ok({ years: '51' }), TODAY).years).toMatch(/1 to 50/);
    expect(guaranteeErrors(ok({ years: '50' }), TODAY).years).toBeUndefined();
  });
});

describe('completion date', () => {
  it('is required, with no default', () => {
    expect(emptyGuarantee().completedOn).toBe('');
    expect(guaranteeErrors(ok({ completedOn: '' }), TODAY).completedOn).toMatch(/Enter the date/);
  });
  it('must be a real calendar date', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '19/10/2026', 'yesterday', '2026-1-5']) expect(guaranteeErrors(ok({ completedOn: bad }), TODAY).completedOn, bad).toMatch(/real date/);
  });
  it('may be today or earlier but never in the future', () => {
    expect(guaranteeErrors(ok({ completedOn: TODAY }), TODAY).completedOn).toBeUndefined();
    expect(guaranteeErrors(ok({ completedOn: '2026-10-18' }), TODAY).completedOn).toBeUndefined();
    expect(guaranteeErrors(ok({ completedOn: '2026-10-20' }), TODAY).completedOn).toMatch(/future/);
    expect(guaranteeErrors(ok({ completedOn: '2031-01-01' }), TODAY).completedOn).toMatch(/future/);
  });
  it('refuses a date that is plainly a typo for the year', () => {
    expect(guaranteeErrors(ok({ completedOn: '1066-10-14' }), TODAY).completedOn).toMatch(/too long ago/);
  });
});

describe('the rest of the form', () => {
  it('a complete form has no errors', () => {
    expect(guaranteeErrors(ok(), TODAY)).toEqual({});
  });
  it('needs a roof, the words for another roof, and an address', () => {
    const e = guaranteeErrors(emptyGuarantee(), TODAY);
    expect(e.roofType).toBeTruthy();
    expect(e.address).toBeTruthy();
    expect(guaranteeErrors(ok({ roofType: 'other', roofOther: '  ' }), TODAY).roofOther).toMatch(/what the roof is/);
    expect(guaranteeErrors(ok({ roofType: 'other', roofOther: 'garage roof' }), TODAY).roofOther).toBeUndefined();
  });
  it('checks a linked quote number only when one is given', () => {
    expect(guaranteeErrors(ok({ linkedQuote: '' }), TODAY).linkedQuote).toBeUndefined();
    expect(guaranteeErrors(ok({ linkedQuote: 'Q-12' }), TODAY).linkedQuote).toBeUndefined();
    expect(guaranteeErrors(ok({ linkedQuote: 'a b' }), TODAY).linkedQuote).toBeTruthy();
  });
  it('says the roof in the words of the certificate', () => {
    expect(roofWords({ roofType: 'dormer', roofOther: 'ignored' })).toBe('dormer flat roof');
    expect(roofWords({ roofType: 'other', roofOther: '  garage   roof ' })).toBe('garage roof');
    expect(roofLabel({ roofType: 'flat', roofOther: '' })).toBe('Flat roof');
    expect(roofWords({ roofType: '', roofOther: '' })).toBe('');
  });
});

describe('one certificate per roof', () => {
  it('keys the known roofs by type and another roof by its words, ignoring case, spacing and punctuation', () => {
    expect(roofKeyOf({ roofType: 'tiled', roofOther: 'junk' })).toBe('tiled');
    expect(roofKeyOf({ roofType: 'other', roofOther: 'Garage  roof.' })).toBe(roofKeyOf({ roofType: 'other', roofOther: 'garage roof' }));
    expect(roofKeyOf({ roofType: 'other', roofOther: 'garage roof' })).not.toBe(roofKeyOf({ roofType: 'other', roofOther: 'porch roof' }));
    expect(roofKeyOf({ roofType: 'other', roofOther: '  ' })).toBe('');
    expect(roofKeyOf({ roofType: '', roofOther: '' })).toBe('');
  });
});

describe('certificate numbers', () => {
  it('follow the job: GC-{job} first, then GC-{job}-G2 and on', () => {
    expect(documentNumberFor('guarantee', 'XX-002', 'full', 1, 1)).toBe('GC-XX-002');
    expect(documentNumberFor('guarantee', 'XX-002', 'full', 1, 2)).toBe('GC-XX-002-G2');
  });
  it('take the first free place, so a gap is reused and nothing is numbered twice', () => {
    expect(nextCertificateSeq('Q1', [])).toBe(1);
    expect(nextCertificateSeq('Q1', ['GC-Q1'])).toBe(2);
    expect(nextCertificateSeq('Q1', ['GC-Q1', 'GC-Q1-G2'])).toBe(3);
    expect(nextCertificateSeq('Q1', ['GC-Q1-G2'])).toBe(1);
    // A quote numbered QT-{CODE}-{NNN} gives GC-{CODE}-{NNN}, never GC-QT-...
    expect(nextCertificateSeq('QT-GW-001', [])).toBe(1);
    expect(nextCertificateSeq('QT-GW-001', ['GC-GW-001'])).toBe(2);
    expect(nextCertificateSeq('QT-GW-001', ['GC-GW-001', 'GC-GW-001-G2'])).toBe(3);
    // A certificate made the older way still holds its place.
    expect(nextCertificateSeq('QT-GW-001', ['GC-QT-GW-001'])).toBe(2);
    const all = ['GC-Q1', ...Array.from({ length: 19 }, (_, i) => `GC-Q1-G${i + 2}`)];
    expect(nextCertificateSeq('Q1', all)).toBeNull();
  });
});

describe('what is kept', () => {
  it('tidies lines, drops the other-roof words for a known roof and caps lengths', () => {
    const t = tidyGuarantee({ roofType: 'flat', roofOther: 'stray', years: ' 2 0 ', address: '  1 Road,\n Town  ', completedOn: ' 2026-10-01 ', linkedQuote: ' Q-1 ' });
    expect(t).toEqual({ roofType: 'flat', roofOther: '', years: '20', address: '1 Road, Town', completedOn: '2026-10-01', linkedQuote: 'Q-1' });
    expect(tidyGuarantee(ok({ address: 'x'.repeat(500) })).address).toHaveLength(200);
    expect(tidyGuarantee({ ...ok(), roofType: 'bogus' as never }).roofType).toBe('');
  });
  it('round trips through the stored shape, with the roof key the database checks', () => {
    const v = ok({ roofType: 'other', roofOther: 'Garage roof' });
    const stored = storedGuarantee(v);
    expect(stored.guarantee.roofKey).toBe('other:garage roof');
    expect(parseGuaranteeInput(stored)).toEqual(tidyGuarantee(v));
    expect(parseGuaranteeInput({})).toBeNull();
    expect(parseGuaranteeInput(null)).toBeNull();
  });
});
