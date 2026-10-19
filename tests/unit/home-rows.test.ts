import { describe, expect, it } from 'vitest';
import { buildHomeRows, homeFigures, latestByQuote, parseView, rowsFor, viewHref, type JobIn } from '../../src/lib/home-rows';
import { deriveJobStage, surveyedOnlyProgress } from '../../src/lib/job-stage';

const deposit = [
  { index: 1, label: 'Deposit', grossPence: 30000 },
  { index: 2, label: 'Balance', grossPence: 70000 },
];
const job = (quoteNumber: string, progress: JobIn['progress']): JobIn => ({ quoteNumber, customerName: `Cust ${quoteNumber}`, addressLine: '1 High Street', progress });

const toInvoice = job('Q-1', deriveJobStage({ kind: 'deposit' }, deposit, [], []));
const waiting = job('Q-2', deriveJobStage({ kind: 'deposit' }, deposit, [], [{ type: 'deposit-invoice', instalment: 1, status: 'final' }]));
const paidNoReceipt = job('Q-3', deriveJobStage({ kind: 'deposit' }, deposit, [{ instalment: 1, amountPence: 30000 }], [{ type: 'deposit-invoice', instalment: 1, status: 'final' }]));
const done = job('Q-4', deriveJobStage({ kind: 'full' }, [{ index: 1, label: 'Full', grossPence: 1000 }], [{ instalment: 1, amountPence: 1000, receiptLinked: true }], [{ type: 'invoice-full', instalment: 1, status: 'final' }, { type: 'guarantee', instalment: null, status: 'final' }]));
const surveyed = job('S-1', surveyedOnlyProgress(false));
const surveyedDrafting = job('S-2', surveyedOnlyProgress(true));
const drafts = [
  { jobId: 'j1', documentId: 'd1', quoteNumber: 'D-1', customerName: 'Mr Draft', date: '2026-10-12' },
  { jobId: 'j2', documentId: null, quoteNumber: 'S-2', customerName: 'Mrs Survey', date: '2026-10-13' },
];

describe('Home rows', () => {
  const rows = buildHomeRows([surveyed, surveyedDrafting, toInvoice, waiting, paidNoReceipt, done], drafts, latestByQuote([{ quoteNumber: 'Q-1', date: '2026-10-01' }, { quoteNumber: 'Q-1', date: '2026-10-05' }]));

  it('lists jobs in the order given, then drafts; a surveyed job with a draft quote shows once, as the draft', () => {
    expect(rows.map((r) => r.key)).toEqual(['job:S-1', 'job:Q-1', 'job:Q-2', 'job:Q-3', 'job:Q-4', 'draft:j1', 'draft:j2']);
  });

  it('stage in words with a semantic tone: amber waiting, green paid or done, neutral otherwise', () => {
    const by = new Map(rows.map((r) => [r.key, r]));
    expect(by.get('job:Q-2')).toMatchObject({ stage: 'Deposit invoiced', tone: 'amber', waiting: true });
    expect(by.get('job:Q-3')).toMatchObject({ stage: 'Deposit paid', tone: 'green' });
    expect(by.get('job:Q-4')).toMatchObject({ stage: 'All done', tone: 'green', next: null, needsAction: false });
    expect(by.get('job:Q-1')).toMatchObject({ stage: 'Quoted', tone: 'neutral', readyToInvoice: true, updated: '2026-10-05' });
    expect(by.get('draft:j1')).toMatchObject({ stage: 'Draft quote', href: '/documents/d1', updated: '2026-10-12' });
    expect(by.get('draft:j2')?.href).toBe('/documents/new?type=quotation&draft=j2');
  });

  it('a payment with no receipt adds Create receipt and counts as needing action', () => {
    const r = rows.find((x) => x.key === 'job:Q-3')!;
    expect(r.extra).toEqual({ label: 'Create receipt', href: '/documents/new?type=receipt&job=Q-3&n=1' });
    expect(r.needsAction).toBe(true);
  });

  it('views filter the rows; the figures count them', () => {
    expect(rowsFor(rows, 'action').map((r) => r.key)).toEqual(['job:S-1', 'job:Q-1', 'job:Q-3', 'draft:j1', 'draft:j2']);
    expect(rowsFor(rows, 'waiting').map((r) => r.key)).toEqual(['job:Q-2']);
    expect(rowsFor(rows, 'quotes')).toHaveLength(2);
    expect(rowsFor(rows, 'invoice').map((r) => r.key)).toEqual(['job:Q-1', 'job:Q-3']);
    expect(rowsFor(rows, 'all')).toHaveLength(rows.length);
    expect(homeFigures(rows)).toEqual({ quotes: 2, inProgress: 4, toInvoice: 2, waiting: 1 });
  });

  it('views parse safely and link to the table', () => {
    expect(parseView('waiting')).toBe('waiting');
    expect(parseView('nonsense')).toBe('action');
    expect(parseView(['all'])).toBe('action');
    expect(viewHref('action')).toBe('/#jobs');
    expect(viewHref('quotes')).toBe('/?view=quotes#jobs');
  });

  it('nothing at all gives no rows and zero figures', () => {
    expect(buildHomeRows([], [])).toEqual([]);
    expect(homeFigures([])).toEqual({ quotes: 0, inProgress: 0, toInvoice: 0, waiting: 0 });
  });
});
