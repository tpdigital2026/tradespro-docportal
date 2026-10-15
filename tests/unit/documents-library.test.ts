import { describe, expect, it } from 'vitest';
import { groupLibrary, kindOf, pdfFilename, editStepFor, type LibraryItem } from '../../src/lib/data/documents';
import { isCurrent } from '../../src/components/Shell';
import { demoIssuedJobs, demoQuoteDrafts } from '../../src/lib/demo-data';

const item = (over: Partial<LibraryItem>): LibraryItem => ({ id: 'a', type: 'quotation', number: 'Q-1', status: 'final', date: '2026-10-01', customerName: 'Mr John Smith', jobId: 'j1', quoteNumber: 'Q-1', totalPence: 100, createdAt: '2026-10-01T09:00:00Z', ...over });

describe('Documents library', () => {
  const items = [
    item({ id: '1' }),
    item({ id: '2', type: 'deposit-invoice', number: 'INV-Q-1-D', createdAt: '2026-10-02T09:00:00Z' }),
    item({ id: '3', type: 'receipt', number: 'RCP-Q-1-D', status: 'draft', createdAt: '2026-10-03T09:00:00Z' }),
    item({ id: '4', jobId: 'j2', quoteNumber: 'Q-2', number: 'Q-2', customerName: 'Mrs Jane Example', status: 'draft', createdAt: '2026-09-01T09:00:00Z' }),
  ];

  it('groups by job, newest activity first, the quote first inside a job', () => {
    const g = groupLibrary(items);
    expect(g.map((x) => x.quoteNumber)).toEqual(['Q-1', 'Q-2']);
    expect(g[0].items.map((i) => i.type)).toEqual(['quotation', 'deposit-invoice', 'receipt']);
  });

  it('filters by type, status and search on quote number or customer', () => {
    expect(groupLibrary(items, { kind: 'invoice' }).flatMap((g) => g.items.map((i) => i.id))).toEqual(['2']);
    expect(groupLibrary(items, { status: 'draft' }).flatMap((g) => g.items.map((i) => i.id)).sort()).toEqual(['3', '4']);
    expect(groupLibrary(items, { q: 'jane' }).map((g) => g.quoteNumber)).toEqual(['Q-2']);
    expect(groupLibrary(items, { q: 'q-2' }).map((g) => g.quoteNumber)).toEqual(['Q-2']);
    expect(groupLibrary(items, { q: 'nobody' })).toEqual([]);
    expect(kindOf('invoice-stage')).toBe('invoice');
  });

  it('file names come from the document number and never carry odd characters', () => {
    expect(pdfFilename('INV-FJC1001-D', null)).toBe('INV-FJC1001-D.pdf');
    expect(pdfFilename('Q/12.3', 2)).toBe('Q-12.3-v2.pdf');
    expect(pdfFilename('../x', null)).toBe('x.pdf');
  });

  it('Edit opens the stepper where something is missing, else the review', () => {
    expect(editStepFor(demoIssuedJobs[0].form, 2000)).toBe('review');
    expect(editStepFor(demoQuoteDrafts[1].values, 2000)).toBe('scope');
  });

  it('the Documents nav item covers the library, documents and jobs, but not New document', () => {
    expect(isCurrent('/documents', '/documents')).toBe(true);
    expect(isCurrent('/documents/abc', '/documents')).toBe(true);
    expect(isCurrent('/documents/jobs/Q-1', '/documents')).toBe(true);
    expect(isCurrent('/documents/new', '/documents')).toBe(false);
    expect(isCurrent('/documents/new', '/documents/new')).toBe(true);
  });
});
