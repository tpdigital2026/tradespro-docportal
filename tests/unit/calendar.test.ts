import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAppointment, daysCovered, formValuesOf, timeRange, type AppointmentFormValues } from '../../src/lib/calendar/model';
import { byDay, calendarHref, monthWeeks, parseCalendarParams, stepHref, viewSpan, weekDays } from '../../src/lib/calendar/views';

const base: AppointmentFormValues = { kind: 'site_visit', title: 'Measure up', date: '2026-07-01', start: '09:00', endDate: '', end: '', customerId: '', jobId: '', notes: '' };

describe('appointment form rules', () => {
  it('turns UK wall time into instants and keeps plain text', () => {
    const r = checkAppointment({ ...base, end: '10:30', title: '  Measure\tup  ', notes: 'Gate code\r\n\n\n\nis 1234 \u0007' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.startsAt.toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(r.value.endsAt?.toISOString()).toBe('2026-07-01T09:30:00.000Z');
    expect(r.value.title).toBe('Measure up');
    expect(r.value.notes).toBe('Gate code\n\nis 1234');
    expect(r.value.customerId).toBeNull();
  });

  it('refuses what does not make sense, in plain words', () => {
    const bad = (v: Partial<AppointmentFormValues>) => {
      const r = checkAppointment({ ...base, ...v });
      return r.ok ? null : r.errors;
    };
    expect(bad({ kind: 'party' })?.kind).toMatch(/kind/);
    expect(bad({ title: '   ' })?.title).toMatch(/title/);
    expect(bad({ title: 'x'.repeat(121) })?.title).toMatch(/120/);
    expect(bad({ notes: 'x'.repeat(1001) })?.notes).toMatch(/1000/);
    expect(bad({ end: '08:00' })?.end).toMatch(/after the start/);
    expect(bad({ endDate: '2026-07-20', end: '09:00' })?.end).toMatch(/14 days/);
    expect(bad({ endDate: '2026-07-02' })?.end).toMatch(/end time/);
    expect(bad({ date: '2026-03-29', start: '01:30' })?.start).toMatch(/clocks go forward/);
    expect(bad({ customerId: "x' or 1=1" })?.customerId).toBeTruthy();
    expect(bad({ date: '2026-02-30' })?.date).toBeTruthy();
    expect(bad({ date: '1999-12-31' })?.date).toMatch(/between 2000 and 2099/);
    expect(bad({ date: '2100-01-01' })?.date).toMatch(/between 2000 and 2099/);
    expect(bad({ endDate: '2100-01-01', end: '09:00' })?.endDate).toMatch(/between 2000 and 2099/);
    expect(checkAppointment({ ...base, date: '2099-12-31', start: '23:45' }).ok).toBe(true);
    expect(checkAppointment({ ...base, extra: 'x' }).ok).toBe(false);
  });

  it('multi-day work covers each day; a midnight end does not spill over', () => {
    const r = checkAppointment({ ...base, endDate: '2026-07-03', end: '17:00' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = { startsAt: r.value.startsAt.toISOString(), endsAt: r.value.endsAt!.toISOString() };
    expect(daysCovered(a)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(timeRange(a)).toBe('09:00 to 3 Jul, 17:00');
    expect(daysCovered({ startsAt: '2026-07-01T20:00:00Z', endsAt: '2026-07-01T23:00:00Z' })).toEqual(['2026-07-01']); // 21:00 to midnight BST
  });

  it('round-trips through the form values', () => {
    const r = checkAppointment({ ...base, date: '2026-10-25', start: '01:30', end: '03:00', notes: 'n' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = formValuesOf({ id: 'a', kind: 'survey', title: 't', startsAt: r.value.startsAt.toISOString(), endsAt: r.value.endsAt!.toISOString(), customerId: null, customerName: null, jobId: null, quoteNumber: null, notes: 'n' });
    expect(v).toMatchObject({ date: '2026-10-25', start: '01:30', end: '03:00', endDate: '' });
  });
});

describe('calendar views', () => {
  it('month grids run Monday to Sunday and cover the whole month', () => {
    const w = monthWeeks('2026-10');
    expect(w[0][0]).toBe('2026-09-28');
    expect(w[w.length - 1][6]).toBe('2026-11-01');
    expect(w.flat()).toContain('2026-10-31');
    expect(weekDays('2026-10-15')[0]).toBe('2026-10-12');
  });

  it('reads parameters safely and builds links', () => {
    expect(parseCalendarParams({ view: 'evil', d: '2026-99-01', m: 'x' }, '2026-10-15')).toEqual({ view: 'auto', month: '2026-10', day: '2026-10-15' });
    const p = parseCalendarParams({ view: 'week', d: '2026-10-15' }, '2026-10-15');
    expect(viewSpan(p, 'week')).toEqual({ first: '2026-10-12', last: '2026-10-18' });
    expect(stepHref(p, 'week', 1)).toBe('/calendar?view=week&d=2026-10-19');
    expect(stepHref({ ...p, month: '2026-12' }, 'month', 1)).toBe('/calendar?view=month&m=2027-01');
    expect(calendarHref({ view: 'auto' })).toBe('/calendar');
  });

  it('groups by London day', () => {
    const m = byDay([
      { id: 'b', kind: 'other', title: 'late', startsAt: '2026-06-30T23:30:00Z', endsAt: null, customerId: null, customerName: null, jobId: null, quoteNumber: null, notes: null },
      { id: 'a', kind: 'other', title: 'early', startsAt: '2026-07-01T06:00:00Z', endsAt: null, customerId: null, customerName: null, jobId: null, quoteNumber: null, notes: null },
    ]);
    expect(m.get('2026-07-01')?.map((x) => x.id)).toEqual(['b', 'a']);
    expect(m.has('2026-06-30')).toBe(false);
  });
});

describe('demo appointments', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('NODE_ENV', 'test');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('save, link rule and delete work in memory', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/session', () => ({ requireSession: async () => ({ tenantId: 'demo-tenant', userId: 'demo-user' }) }));
    const data = await import('../../src/lib/data/appointments');
    const { resetDemoAppointments } = await import('../../src/lib/demo-business');
    resetDemoAppointments();
    const ok = checkAppointment({ ...base, jobId: 'demo-job-3003' });
    if (!ok.ok) throw new Error('form');
    const id = await data.saveAppointment(null, ok.value);
    const got = await data.getAppointment(id);
    expect(got).toMatchObject({ customerId: 'demo-customer-1', quoteNumber: 'QT-BR-003' });
    const wrong = checkAppointment({ ...base, jobId: 'demo-job-3003', customerId: 'demo-customer-2' });
    if (!wrong.ok) throw new Error('form');
    await expect(data.saveAppointment(null, wrong.value)).rejects.toThrow(/different customer/);
    await data.deleteAppointment(id);
    expect(await data.getAppointment(id)).toBeNull();
    await expect(data.deleteAppointment(id)).rejects.toThrow(/could not be found/);
  });
});
