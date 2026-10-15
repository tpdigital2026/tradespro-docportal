import { describe, expect, it } from 'vitest';
import { draftCoveringEmail, draftCoveringEmailParts, tidyNotes, type CoveringEmailFacts } from '../../src/lib/covering-email';

/** The word the owner never wants in copy, built so this file does not contain it. */
const BANNED = new RegExp(`\\b${'actu'}${'ally'}\\b`, 'i');

const quote: CoveringEmailFacts = { kind: 'quotation', number: 'Q-1', customerName: 'Mr John Smith', businessName: 'FJC Roofing Ltd', ownerName: 'Ben Cunningham', property: '123 Bromley Road', amountPence: 1008000, validityDays: 30 };

describe('draftCoveringEmail', () => {
  it('uses only facts from the document', () => {
    const e = draftCoveringEmailParts({ facts: quote });
    expect(e.subject).toBe('Quotation Q-1 from FJC Roofing Ltd');
    expect(e.body).toContain('Dear Mr John Smith,');
    expect(e.body).toContain('£10,080.00');
    expect(e.body).toContain('valid for 30 days');
    expect(e.body).toContain('Ben Cunningham\nFJC Roofing Ltd');
  });

  it('leaves out anything with no value instead of guessing', () => {
    const e = draftCoveringEmailParts({ facts: { ...quote, property: '', amountPence: null, validityDays: null, customerName: '' } });
    expect(e.body).toContain('Hello,');
    expect(e.body).not.toMatch(/£|valid for|work at/);
  });

  it('adds no dates, prices or promises of its own, and no em dashes', () => {
    for (const kind of ['quotation', 'deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage', 'receipt'] as const) {
      const body = draftCoveringEmail({ facts: { kind, number: 'N-1', customerName: 'A', businessName: 'B', ownerName: 'C' } });
      expect(body).not.toMatch(/\d{1,2}\/\d{1,2}|£|guarantee|promise|within \d|\u2014/i);
      expect(body).not.toMatch(BANNED);
    }
  });

  it('puts the owner\'s own words in as written, tidied for spacing only', () => {
    const body = draftCoveringEmail({ facts: quote, ownerNotes: '  We can   start on Monday.\n\n\n\nThanks  ' });
    expect(body).toContain('We can start on Monday.\n\nThanks');
    expect(tidyNotes('a\r\nb')).toBe('a\nb');
  });

  it('invoices name the part of the job and the quote; receipts thank for the payment', () => {
    const inv = draftCoveringEmail({ facts: { kind: 'invoice-stage', number: 'INV-Q-1-S2', customerName: 'A', businessName: 'B', ownerName: 'C', amountPence: 500, quoteRef: 'Q-1', partLabel: 'Stage 2 of 5: Roof structure complete' } });
    expect(inv).toContain('for stage 2 of 5: Roof structure complete (quote Q-1)');
    expect(inv).toContain('The amount due is £5.00');
    const rc = draftCoveringEmail({ facts: { kind: 'receipt', number: 'RCP-Q-1', customerName: 'A', businessName: 'B', ownerName: 'C', amountPence: 500, quoteRef: 'Q-1' } });
    expect(rc).toContain('received your payment of £5.00');
  });
});
