import { describe, expect, it } from 'vitest';
import { isCodedQuoteNumber, jobStem, nextQuoteNumber, quoteNumberFor, stemVariants, streetNameOf, suggestJobCode } from '../../src/lib/doc-numbers';
import { documentNumberFor, documentNumberForms, instalmentFromNumber } from '../../src/lib/job-stage';
import { NUMBER_RE, quoteNumberReserved } from '../../src/lib/validation/quote';

describe('the stem a quote number gives to its documents', () => {
  it('drops QT- and keeps everything else, so legacy numbers are unchanged', () => {
    expect(jobStem('QT-GW-001')).toBe('GW-001');
    expect(jobStem('qt-gw-001')).toBe('gw-001');
    expect(jobStem('QT-GW-001-1')).toBe('GW-001-1');
    expect(jobStem('FJC1003')).toBe('FJC1003');
    expect(jobStem('DEMO-2001')).toBe('DEMO-2001');
    expect(jobStem('QT-')).toBe('QT-');
  });

  it('names both forms that would give the same invoice numbers', () => {
    expect(stemVariants('QT-GW-001')).toEqual(['QT-GW-001', 'GW-001']);
    expect(stemVariants('GW-001')).toEqual(['GW-001', 'QT-GW-001']);
    expect(stemVariants('FJC1003')).toEqual(['FJC1003', 'QT-FJC1003']);
  });
});

describe('document numbers follow the owner\'s real documents', () => {
  it('quote QT-GW-001 gives INV-GW-001-D / -B, RCP-GW-001-D / -B and GC-GW-001 (never GC-QT-...)', () => {
    expect(documentNumberFor('deposit-invoice', 'QT-GW-001', 'deposit', 1)).toBe('INV-GW-001-D');
    expect(documentNumberFor('balance-invoice', 'QT-GW-001', 'deposit', 2)).toBe('INV-GW-001-B');
    expect(documentNumberFor('receipt', 'QT-GW-001', 'deposit', 1)).toBe('RCP-GW-001-D');
    expect(documentNumberFor('receipt', 'QT-GW-001', 'deposit', 2)).toBe('RCP-GW-001-B');
    expect(documentNumberFor('guarantee', 'QT-GW-001', 'full', 1, 1)).toBe('GC-GW-001');
    expect(documentNumberFor('guarantee', 'QT-GW-001', 'full', 1, 2)).toBe('GC-GW-001-G2');
  });

  it('keeps the other suffix rules working with the new shape: full, stage and later receipts', () => {
    expect(documentNumberFor('invoice-full', 'QT-GW-001', 'full', 1)).toBe('INV-GW-001');
    expect(documentNumberFor('receipt', 'QT-GW-001', 'full', 1)).toBe('RCP-GW-001');
    expect(documentNumberFor('invoice-stage', 'QT-GW-001', 'staged', 3)).toBe('INV-GW-001-S3');
    expect(documentNumberFor('receipt', 'QT-GW-001', 'staged', 3, 2)).toBe('RCP-GW-001-S3-P2');
    expect(documentNumberFor('receipt', 'QT-GW-001', 'deposit', 1, 3)).toBe('RCP-GW-001-D-P3');
  });

  it('a quote revision that keeps its number and adds -1 carries it through (QT-GW-001-1 gives INV-GW-001-1-B)', () => {
    expect(documentNumberFor('balance-invoice', 'QT-GW-001-1', 'deposit', 2)).toBe('INV-GW-001-1-B');
  });

  it('legacy numbers such as FJC1003 stay valid and unchanged', () => {
    expect(documentNumberFor('deposit-invoice', 'FJC1003', 'deposit', 1)).toBe('INV-FJC1003-D');
    expect(documentNumberFor('receipt', 'FJC1003', 'deposit', 2)).toBe('RCP-FJC1003-B');
    expect(documentNumberFor('guarantee', 'FJC1003', 'full', 1, 1)).toBe('GC-FJC1003');
  });

  it('documents made before the new numbering (INV-QT-9-D) are still recognised, and a new one has the new form first', () => {
    expect(documentNumberForms('deposit-invoice', 'QT-9', 'deposit', 1)).toEqual(['INV-9-D', 'INV-QT-9-D']);
    expect(documentNumberForms('deposit-invoice', 'FJC1003', 'deposit', 1)).toEqual(['INV-FJC1003-D']);
    expect(instalmentFromNumber('deposit-invoice', 'INV-QT-9-D', 'QT-9', 'deposit', 2)).toBe(1);
    expect(instalmentFromNumber('balance-invoice', 'INV-9-B', 'QT-9', 'deposit', 2)).toBe(2);
    expect(instalmentFromNumber('receipt', 'RCP-QT-9-B-P2', 'QT-9', 'deposit', 2)).toBe(2);
    expect(instalmentFromNumber('deposit-invoice', 'INV-OTHER-D', 'QT-9', 'deposit', 2)).toBeNull();
  });

  it('quote numbers in the new shape are allowed and are not reserved endings', () => {
    for (const n of ['QT-GW-001', 'QT-GW-001-1', 'QT-ABC-042', 'QT-MA-003']) {
      expect(NUMBER_RE.test(n), n).toBe(true);
      expect(quoteNumberReserved(n), n).toBeNull();
    }
  });

  it('QT-GW-001 and GW-001 would give the same documents, so both forms are checked when a number is taken', () => {
    const a = documentNumberFor('deposit-invoice', 'QT-GW-001', 'deposit', 1);
    const b = documentNumberFor('deposit-invoice', 'GW-001', 'deposit', 1);
    expect(a).toBe(b);
    expect(stemVariants('QT-GW-001')).toContain('GW-001');
  });
});

describe('the job code from the property address', () => {
  it('uses the initials of the street name including the type word: Grafton Way gives GW', () => {
    expect(suggestJobCode('33 Grafton Way, London, W1T 5DA')).toBe('GW');
    expect(suggestJobCode('205 Montrose Avenue, Welling, DA16 2QU')).toBe('MA');
    expect(suggestJobCode('10 Woodlands Road')).toBe('WR');
    expect(suggestJobCode('123 Bromley Road, Bromley, BR2 8BG')).toBe('BR');
  });

  it('ignores the house number, flat and unit words', () => {
    expect(streetNameOf('62A Elm Park')).toBe('Elm Park');
    expect(streetNameOf('Flat 2, 10 Grafton Way'.split(',')[0])).toBe('');
    expect(suggestJobCode('Flat 2 10 Grafton Way')).toBe('GW');
    expect(suggestJobCode('Unit 4B 12-14 Station Road')).toBe('SR');
    expect(suggestJobCode('2D Greencourt Road')).toBe('GR');
  });

  it('takes at most three letters, drops apostrophes and keeps hyphenated words as one', () => {
    expect(suggestJobCode("14 St John's Church Road")).toBe('SJC');
    expect(suggestJobCode('8 Great North Western Road')).toBe('GNW');
    expect(suggestJobCode('3 Well-Hall Road')).toBe('WR');
  });

  it('a single-word street uses its first two letters', () => {
    expect(suggestJobCode('7 Broadway')).toBe('BR');
  });

  it('a commercial client with no street uses the client\'s initials; with nothing usable it leaves the code for the owner', () => {
    expect(suggestJobCode('', 'Kingsley Roofing Southern')).toBe('KRS');
    expect(suggestJobCode('', 'Mr John Smith')).toBe('JS');
    expect(suggestJobCode('', 'Acme')).toBe('AC');
    expect(suggestJobCode('', '')).toBe('');
    expect(suggestJobCode('12', '')).toBe('');
  });

  it('is always two or three upper-case letters, or empty', () => {
    for (const a of ['1 A', '33 Grafton Way', "5 O'Connell Street", '9 Éire Road', 'The Crescent', '', '   ']) {
      expect(suggestJobCode(a)).toMatch(/^(?:[A-Z]{2,3})?$/);
    }
  });
});

describe('the running number per code', () => {
  it('starts at 001 and goes one past the highest used for that code', () => {
    expect(nextQuoteNumber('GW', [])).toBe('QT-GW-001');
    expect(nextQuoteNumber('GW', ['QT-GW-001'])).toBe('QT-GW-002');
    expect(nextQuoteNumber('GW', ['QT-GW-001', 'QT-GW-004'])).toBe('QT-GW-005');
    expect(nextQuoteNumber('GW', ['QT-MA-009', 'FJC1003', 'INV-GW-001-D'])).toBe('QT-GW-001');
  });

  it('counts a revision ending as its base number and ignores other codes', () => {
    expect(nextQuoteNumber('GW', ['QT-GW-001-1'])).toBe('QT-GW-002');
    expect(nextQuoteNumber('MA', ['QT-GW-007', 'QT-MA-002'])).toBe('QT-MA-003');
  });

  it('is case-insensitive about the code and skips a number whose stem is already used', () => {
    expect(nextQuoteNumber('gw', ['qt-gw-001'])).toBe('QT-GW-002');
    expect(nextQuoteNumber('GW', ['GW-001'])).toBe('QT-GW-002');
  });

  it('does not stop at 999 and returns nothing without a code', () => {
    expect(nextQuoteNumber('GW', ['QT-GW-999'])).toBe('QT-GW-1000');
    expect(nextQuoteNumber('', ['QT-GW-001'])).toBe('');
  });

  it('formats and recognises the shape', () => {
    expect(quoteNumberFor('gw', 7)).toBe('QT-GW-007');
    expect(isCodedQuoteNumber('QT-GW-007')).toBe(true);
    expect(isCodedQuoteNumber('QT-GW-007-2')).toBe(true);
    expect(isCodedQuoteNumber('FJC1003')).toBe(false);
    expect(isCodedQuoteNumber('QT-9')).toBe(false);
  });
});
