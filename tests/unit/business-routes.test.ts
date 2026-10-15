import { beforeEach, describe, expect, it, vi } from 'vitest';

const state: { session: unknown } = { session: null };
vi.mock('../../src/lib/session', () => ({ getSession: async () => state.session, requireSession: async () => state.session }));
vi.mock('../../src/lib/data/business', () => ({
  getBusinessFacts: async () => ({
    jobs: [
      {
        jobId: 'j1', quoteNumber: 'Q1', customerId: 'c1', customerName: '@evil', addressLine: '', planKind: 'full',
        quote: { documentId: 'q', issuedAt: '2026-10-01T09:00:00Z', grossPence: 1000, schedule: [{ index: 1, label: 'Invoice', grossPence: 1000 }] },
        draftQuoteId: null,
        documents: [{ id: 'i', type: 'invoice-full', number: 'INV-Q1', status: 'final', docDate: '2026-10-02', finalisedAt: '2026-10-02T10:00:00Z', totalPence: 1000, dueWording: null, guaranteeYears: null, certificateNo: null }],
        payments: [],
      },
    ],
    truncated: false,
    noJobPage: new Set(),
  }),
}));
vi.mock('../../src/lib/data/appointments', () => ({
  isAppointmentId: (id: string) => id === '11111111-1111-4111-8111-111111111111',
  getAppointment: async () => ({ id: '11111111-1111-4111-8111-111111111111', kind: 'survey', title: 'Roof, survey', startsAt: '2026-07-01T08:00:00Z', endsAt: null, notes: null, updatedAt: '2026-06-01T00:00:00Z' }),
  listAppointments: async () => [],
}));

import { GET as exportCsv } from '../../src/app/api/money/export/route';
import { GET as ics } from '../../src/app/api/calendar/ics/route';

describe('business routes', () => {
  beforeEach(() => {
    state.session = null;
  });

  it('refuse without a session', async () => {
    expect((await exportCsv(new Request('http://x/api/money/export'))).status).toBe(401);
    expect((await ics(new Request('http://x/api/calendar/ics?m=2026-10'))).status).toBe(401);
  });

  it('the CSV export is a safe attachment of the visible rows', async () => {
    state.session = { tenantId: 't', userId: 'u' };
    const res = await exportCsv(new Request('http://x/api/money/export?view=balances&f=all'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="balances-all.csv"');
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    const body = await res.text();
    expect(body).toContain(`"'@evil"`);
  });

  it('calendar files: one appointment, a month, and refusals', async () => {
    state.session = { tenantId: 't', userId: 'u' };
    const one = await ics(new Request('http://x/api/calendar/ics?id=11111111-1111-4111-8111-111111111111'));
    expect(one.headers.get('content-type')).toMatch(/text\/calendar/);
    expect(one.headers.get('content-disposition')).toBe('attachment; filename="Roof-survey.ics"');
    expect(await one.text()).toContain('SUMMARY:Roof\\, survey');
    expect((await ics(new Request('http://x/api/calendar/ics?id=nope'))).status).toBe(404);
    expect((await ics(new Request('http://x/api/calendar/ics?m=2026-13'))).status).toBe(400);
    const month = await ics(new Request('http://x/api/calendar/ics?m=2026-10'));
    expect(await month.text()).toContain('X-WR-CALNAME:Appointments\\, October 2026');
  });
});
