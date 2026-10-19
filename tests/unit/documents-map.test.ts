import { describe, expect, it } from 'vitest';
import { demoBusiness, demoCustomers, demoIssuedJobs, demoQuoteDrafts } from '../../src/lib/demo-data';
import { firstAddressLine, jobTitleOf, longDate, mapDocument, paymentReferenceFor, redactMapped, slashDate, type DocumentFacts } from '../../src/lib/documents/map';
import { summarise } from '../../src/lib/documents/summary';
import { normaliseQuote } from '../../src/lib/validation/quote';
import { emptyScope } from '../../src/lib/scope/model';
import type { BalanceInvoiceInput, DepositInvoiceInput, FullInvoiceInput, StageInvoiceInput } from '../../src/templates/invoice';
import type { QuotationInput } from '../../src/templates/quotation';
import type { ReceiptInput } from '../../src/templates/receipt';

const biz = { ...demoBusiness, vatRateBp: 2000 };
const bank = { accountName: 'Demo Business Account', bankName: 'Demo Bank', sortCode: '00-00-00', accountNumber: '00000000' };

function factsFor(jobIx: number, over: Partial<DocumentFacts> = {}): DocumentFacts {
  const j = demoIssuedJobs[jobIx];
  const c = demoCustomers.find((x) => x.id === j.form.customerId)!;
  return {
    type: 'quotation', number: j.form.quoteNumber, docDate: j.form.date, quoteNumber: j.form.quoteNumber, propertyAddress: j.form.propertyAddress,
    jobTypeLabel: 'Flat roof', guaranteeYears: 20, customer: { name: c.name, addressLines: c.addressLines, postcode: c.postcode, email: '', phone: '' },
    quoteForm: j.form, plan: normaliseQuote(j.form, 'draft', 2000).input.plan, documents: j.documents, payments: j.payments, followOn: null, bank, ...over,
  };
}

describe('dates', () => {
  it('formats long and slash dates and refuses impossible ones', () => {
    expect(longDate('2026-09-21')).toBe('21 September 2026');
    expect(slashDate('2026-09-21')).toBe('21/09/2026');
    expect(longDate('2026-02-30')).toBe('');
    expect(longDate('')).toBe('');
  });
});

describe('mapQuotation', () => {
  it('maps a finished quote, recomputing money and the schedule from the plan', () => {
    const r = mapDocument(factsFor(0), biz);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.mapped.input as QuotationInput;
    expect(q.ref).toBe('QT-BR-001');
    expect(q.dateLabel).toBe('8 October 2026');
    expect(q.terms).toBe(biz.wording.quote.terms);
    expect(q.diagram).toBeNull();
    expect(q.paymentSchedule).toEqual([['Deposit (30%)', '£3,024.00'], ['Balance due on completion', '£7,056.00']]);
    expect(r.money).toMatchObject({ netPence: 840000, vatPence: 168000, grossPence: 1008000 });
    expect(r.money.schedule?.map((i) => i.grossPence)).toEqual([302400, 705600]);
    expect(q.guarantee?.years).toBe(20);
  });

  it('never invents contact details: empty email and phone stay empty', () => {
    const r = mapDocument(factsFor(0), biz);
    if (!r.ok) throw new Error('expected ok');
    const q = r.mapped.input as QuotationInput;
    expect(q.customer.email).toBe('');
    expect(q.customer.phone).toBe('');
  });

  it('blocks with plain reasons when the wording is not approved, the plan is missing or terms are not set up', () => {
    const f = factsFor(0, { quoteForm: { ...demoIssuedJobs[0].form, scope: emptyScope() }, plan: null });
    const r = mapDocument(f, { ...biz, wording: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing.join(' ')).toMatch(/not been approved/);
    expect(r.missing.join(' ')).toMatch(/no payment plan/);
    expect(r.missing.join(' ')).toMatch(/terms are not set up/);
  });

  it('a draft without approved wording is reported, not printed', () => {
    const d = demoQuoteDrafts[1];
    const r = mapDocument({ ...factsFor(0), quoteForm: d.values, plan: normaliseQuote(d.values, 'draft', 2000).input.plan }, biz);
    expect(r.ok).toBe(false);
  });
});

describe('follow-on documents', () => {
  it('deposit invoice: figures from the schedule, bank details carried, redacted for storage', () => {
    const r = mapDocument(factsFor(0, { type: 'deposit-invoice', number: 'INV-BR-001-D', followOn: { instalment: 1, paymentId: null } }), biz);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.mapped.input as DepositInvoiceInput;
    expect(d.depositPctBp).toBe(3000);
    expect(r.money.grossPence).toBe(302400);
    expect(d.bank.accountNumber).toBe('00000000');
    const red = JSON.stringify(redactMapped(r.mapped));
    expect(red).not.toContain('00000000');
    expect(red).not.toContain('00-00-00');
    expect(red).toContain('accountEnding');
  });

  it('an invoice without bank details is blocked', () => {
    const r = mapDocument(factsFor(0, { type: 'deposit-invoice', number: 'INV-BR-001-D', followOn: { instalment: 1, paymentId: null }, bank: null }), biz);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing.join(' ')).toMatch(/No bank account is set up yet.*add one in Settings/);
  });

  it('deposit wording naming a different percentage than the job blocks the invoice', () => {
    const j = demoIssuedJobs[0];
    const form = { ...j.form, plan: { ...j.form.plan, depositPct: '25' } };
    const r = mapDocument(factsFor(0, { type: 'deposit-invoice', number: 'INV-BR-001-D', followOn: { instalment: 1, paymentId: null }, quoteForm: form, plan: normaliseQuote(form, 'draft', 2000).input.plan }), biz);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing.join(' ')).toMatch(/different deposit/);
  });

  it('a number that no longer matches the job is refused', () => {
    const r = mapDocument(factsFor(0, { type: 'deposit-invoice', number: 'INV-OTHER-D', followOn: { instalment: 1, paymentId: null } }), biz);
    expect(r.ok).toBe(false);
  });

  it('receipt: amount is the payment itself; earlier payments come from the record', () => {
    const r = mapDocument(factsFor(0, { type: 'receipt', number: 'RCP-BR-001-D', followOn: { instalment: 1, paymentId: 'demo-payment-3001-1' } }), biz);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rc = r.mapped.input as ReceiptInput;
    expect(rc.kind).toBe('deposit');
    expect(rc.amountPaidPence).toBe(302400);
    expect(rc.previousPaymentsPence).toEqual([]);
    expect(rc.paidDateLabel).toBe('11/10/2026');
    expect(rc.invoiceRef).toBe('INV-BR-001-D');
  });

  it('balance invoice waits until the deposit is paid in full', () => {
    const j = demoIssuedJobs[0];
    const ok = mapDocument(factsFor(0, { type: 'balance-invoice', number: 'INV-BR-001-B', followOn: { instalment: 2, paymentId: null } }), biz);
    expect(ok.ok).toBe(true);
    const part = mapDocument(factsFor(0, { type: 'balance-invoice', number: 'INV-BR-001-B', followOn: { instalment: 2, paymentId: null }, payments: [{ ...j.payments[0], amountPence: 1000 }] }), biz);
    expect(part.ok).toBe(false);
  });

  it('stage invoice: the stage from the schedule, with what was received before it', () => {
    const r = mapDocument(factsFor(2, { type: 'invoice-stage', number: 'INV-BR-003-S3', followOn: { instalment: 3, paymentId: null } }), biz);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.mapped.input as StageInvoiceInput;
    expect(s.stage.index).toBe(3);
    expect(s.stageCount).toBe(5);
    expect(s.receivedPence).toBe(1200000);
    expect(r.money.grossPence).toBe(750000);
    expect(s.terms).toBe(biz.wording.balance_invoice.terms);
  });

  it('full invoice uses its own wording when the business has some', () => {
    const wording = { ...biz.wording, invoice_full: { terms: 'Own full terms.', dueNote: 'Own due note' } };
    const r = mapDocument(factsFor(1, { type: 'invoice-full', number: 'INV-BR-002', followOn: { instalment: 1, paymentId: null } }), { ...biz, wording });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.mapped.input as { terms: string }).terms).toBe('Own full terms.');
  });
});

describe('the owner\'s own wording and conventions on invoices, receipts and quotes', () => {
  const fo = (instalment: number) => ({ instalment, paymentId: null });
  const deposit = () => mapDocument(factsFor(0, { type: 'deposit-invoice', number: 'INV-BR-001-D', followOn: fo(1) }), biz);
  const balance = (wording = biz.wording) => mapDocument(factsFor(0, { type: 'balance-invoice', number: 'INV-BR-001-B', followOn: fo(2) }), { ...biz, wording });

  it('the line item reads "[job title in lower case] as specified above"', () => {
    const r = deposit();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.mapped.input as DepositInvoiceInput;
    expect(d.jobDescription).toBe(`${d.jobTitle.toLowerCase()} as specified above`);
    expect(d.jobDescription).toMatch(/^[^A-Z]+ as specified above$/);
  });

  it('the invoice heading is the quote title without its last word "Quotation"', () => {
    expect(jobTitleOf('Fascia Replacement Quotation')).toBe('Fascia Replacement');
    expect(jobTitleOf('Flat Roof Installation quotation ')).toBe('Flat Roof Installation');
    expect(jobTitleOf('Quotation')).toBe('Quotation');
    expect(jobTitleOf('Full Roof Replacement')).toBe('Full Roof Replacement');
  });

  it('deposit invoice: Due "Before works start", and the terms keep a {balance} slot for the template to fill', () => {
    const r = deposit();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.mapped.input as DepositInvoiceInput;
    expect(d.dueLabel).toBe('Before works start');
    expect(d.terms).toBe('The 30% deposit is payable before works start. The remaining balance of {balance} is due on completion of works.');
  });

  it('balance invoice: Due "On receipt", the box note and terms say payment is due on receipt', () => {
    const r = balance();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.mapped.input as BalanceInvoiceInput;
    expect(b.dueLabel).toBe('On receipt');
    expect(b.dueNote).toBe('Payment is due upon receipt of this invoice');
    expect(b.terms).toBe('Payment is due upon receipt of this invoice.');
  });

  it('a payment term the business has not supplied is left out, never invented', () => {
    const { dueLabel: _gone, ...noDue } = biz.wording.balance_invoice;
    const r = balance({ ...biz.wording, balance_invoice: noDue });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.mapped.input as BalanceInvoiceInput).dueLabel).toBeUndefined();
  });

  it('full and stage invoices get the same Due line: their own wording, else the balance invoice\'s', () => {
    const own = { ...biz.wording, invoice_full: { terms: 'Own full terms.', dueNote: 'Own due note', dueLabel: 'Within 7 days' } };
    const full = mapDocument(factsFor(1, { type: 'invoice-full', number: 'INV-BR-002', followOn: fo(1) }), { ...biz, wording: own });
    expect(full.ok && (full.mapped.input as FullInvoiceInput).dueLabel).toBe('Within 7 days');
    const fallback = mapDocument(factsFor(1, { type: 'invoice-full', number: 'INV-BR-002', followOn: fo(1) }), biz);
    expect(fallback.ok && (fallback.mapped.input as FullInvoiceInput).dueLabel).toBe('On receipt');
    const stage = mapDocument(factsFor(2, { type: 'invoice-stage', number: 'INV-BR-003-S3', followOn: fo(3) }), biz);
    expect(stage.ok && (stage.mapped.input as StageInvoiceInput).dueLabel).toBe('On receipt');
  });

  it('the payment reference is the first line of the job address, whatever the business wording says by default', () => {
    expect(firstAddressLine('123 Bromley Road, Bromley, BR2 8BG')).toBe('123 Bromley Road');
    expect(firstAddressLine('Flat 2\n10 Example Way')).toBe('Flat 2');
    const r = deposit();
    expect(r.ok && (r.mapped.input as DepositInvoiceInput).paymentRef).toBe('123 Bromley Road');
  });

  it('the payment reference convention is a setting: invoice number on request, and the invoice number when there is no job address', () => {
    expect(paymentReferenceFor({ number: 'INV-BR-001-D', propertyAddress: '1 Example Way, Town' }, 'invoice_number')).toBe('INV-BR-001-D');
    expect(paymentReferenceFor({ number: 'INV-BR-001-D', propertyAddress: '1 Example Way, Town' }, 'address_line_1')).toBe('1 Example Way');
    expect(paymentReferenceFor({ number: 'INV-BR-001-D', propertyAddress: '1 Example Way, Town' }, undefined)).toBe('1 Example Way');
    expect(paymentReferenceFor({ number: 'INV-BR-001-D', propertyAddress: '  ' }, 'address_line_1')).toBe('INV-BR-001-D');
    const r = mapDocument(factsFor(0, { type: 'deposit-invoice', number: 'INV-BR-001-D', followOn: fo(1) }), { ...biz, wording: { ...biz.wording, paymentReference: 'invoice_number' } });
    expect(r.ok && (r.mapped.input as DepositInvoiceInput).paymentRef).toBe('INV-BR-001-D');
    const noAddress = mapDocument(factsFor(0, { type: 'deposit-invoice', number: 'INV-BR-001-D', followOn: fo(1), propertyAddress: '' }), biz);
    expect(noAddress.ok && (noAddress.mapped.input as DepositInvoiceInput).paymentRef).toBe('INV-BR-001-D');
  });

  it('the quote\'s price row follows the owner\'s pattern: job, first address line, "complete works as specified above"', () => {
    const r = mapDocument(factsFor(0), biz);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.mapped.input as QuotationInput;
    expect(q.lines[0].description).toBe('Flat roof replacement – 123 Bromley Road, complete works as specified above');
  });

  it('the receipt row names the job in lower case, with the balance and quote reference printed under it', () => {
    const r = mapDocument(factsFor(0, { type: 'receipt', number: 'RCP-BR-001-D', followOn: { instalment: 1, paymentId: 'demo-payment-3001-1' } }), biz);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rc = r.mapped.input as ReceiptInput;
    expect(rc.description).toBe('30% Deposit – flat roof replacement (inc. VAT)');
    expect(rc.quoteRef).toBe('QT-BR-001');
  });
});

describe('summary', () => {
  it('lists what was entered for a quote, with the total and plan in words', () => {
    const s = summarise(factsFor(0), biz, 'Demo Business Account, Demo Bank, ending 0000');
    const flat = s.flatMap((x) => x.rows);
    expect(flat.find((r) => r.label === 'Total')?.value).toBe('£10,080.00');
    expect(flat.find((r) => r.label === 'Wording')?.value).toBe('Approved');
    expect(flat.find((r) => r.label === 'Payment plan')?.value).toMatch(/30% deposit of £3,024.00/);
  });
});

describe('issued facts and stored money', () => {
  it('follow-ons use the VAT rate the quote was issued at, and must agree with its stored total', () => {
    const base = factsFor(0, { type: 'deposit-invoice', number: 'INV-BR-001-D', followOn: { instalment: 1, paymentId: null } });
    // The business VAT setting changed to 0% after the quote was issued at 20%.
    const r = mapDocument({ ...base, quoteIssued: { vatRateBp: 2000, grossPence: 1008000 } }, { ...biz, vatRateBp: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.money.grossPence).toBe(302400);
    const off = mapDocument({ ...base, quoteIssued: { vatRateBp: 2000, grossPence: 999 } }, biz);
    expect(off.ok).toBe(false);
  });

  it('a final document is described from what was stored, never recomputed', async () => {
    const { readIssued } = await import('../../src/lib/documents/issued');
    const r = mapDocument(factsFor(0), biz);
    if (!r.ok) throw new Error('expected ok');
    const fc = { pages: 3, business: { name: 'FJC Roofing Ltd', ownerName: 'Ben Cunningham' }, content: redactMapped(r.mapped) };
    const issued = readIssued(fc, r.money, 'QT-BR-001');
    expect(issued?.email).toMatchObject({ kind: 'quotation', amountPence: 1008000, customerName: 'Mr John Smith', businessName: 'FJC Roofing Ltd', validityDays: 30 });
    const rows = issued!.summary.flatMap((s) => s.rows);
    expect(rows.find((x) => x.label === 'Total')?.value).toBe('£10,080.00');
    expect(rows.find((x) => x.label === 'Deposit (30%)')?.value).toBe('£3,024.00');
    expect(readIssued({ pages: 1 }, null, 'X')).toBeNull();
    const inv = mapDocument(factsFor(2, { type: 'invoice-stage', number: 'INV-BR-003-S3', followOn: { instalment: 3, paymentId: null } }), biz);
    if (!inv.ok) throw new Error('expected ok');
    const i2 = readIssued({ business: { name: 'B', ownerName: 'C' }, content: redactMapped(inv.mapped) }, inv.money, 'INV-BR-003-S3');
    expect(i2?.email).toMatchObject({ partLabel: 'Stage 3 of 5: Roof structure complete', amountPence: 750000, quoteRef: 'QT-BR-003' });
    expect(JSON.stringify(i2)).not.toMatch(/00000000|00-00-00/);
  });
});
