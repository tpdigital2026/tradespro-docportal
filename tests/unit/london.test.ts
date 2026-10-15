import { describe, expect, it } from 'vitest';
import { addDays, addMonths, daysBetween, daysInMonth, isIsoDate, isMonth, londonDate, londonParts, londonToUtc, weekdayMon0 } from '../../src/lib/london';

describe('London dates and times', () => {
  it('reads the London date and offset either side of the clock changes', () => {
    expect(londonParts(new Date('2026-03-29T00:59:00Z'))).toMatchObject({ date: '2026-03-29', time: '00:59', offsetMinutes: 0 });
    expect(londonParts(new Date('2026-03-29T01:00:00Z'))).toMatchObject({ date: '2026-03-29', time: '02:00', offsetMinutes: 60 });
    expect(londonParts(new Date('2026-10-25T00:30:00Z'))).toMatchObject({ time: '01:30', offsetMinutes: 60 });
    expect(londonParts(new Date('2026-10-25T01:30:00Z'))).toMatchObject({ time: '01:30', offsetMinutes: 0 });
    // Late evening UTC in summer is already the next day in London.
    expect(londonDate('2026-06-30T23:30:00Z')).toBe('2026-07-01');
  });

  it('turns a London wall time into the right instant, summer and winter', () => {
    expect(londonToUtc('2026-07-01', '09:00')).toEqual({ ok: true, at: new Date('2026-07-01T08:00:00Z') });
    expect(londonToUtc('2026-12-01', '09:00')).toEqual({ ok: true, at: new Date('2026-12-01T09:00:00Z') });
  });

  it('refuses a time skipped when the clocks go forward, and takes the first of a repeated hour', () => {
    expect(londonToUtc('2026-03-29', '01:30')).toEqual({ ok: false, reason: 'skipped' });
    expect(londonToUtc('2026-03-29', '00:59')).toEqual({ ok: true, at: new Date('2026-03-29T00:59:00Z') });
    expect(londonToUtc('2026-03-29', '02:00')).toEqual({ ok: true, at: new Date('2026-03-29T01:00:00Z') });
    expect(londonToUtc('2026-10-25', '01:30')).toEqual({ ok: true, at: new Date('2026-10-25T00:30:00Z') });
    expect(londonToUtc('2026-10-25', '02:00')).toEqual({ ok: true, at: new Date('2026-10-25T02:00:00Z') });
  });

  it('round-trips every quarter hour of the clock-change days', () => {
    for (const day of ['2026-03-29', '2026-10-25', '2027-03-28', '2027-10-31']) {
      for (let m = 0; m < 24 * 60; m += 15) {
        const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const r = londonToUtc(day, t);
        if (r.ok) expect(londonParts(r.at)).toMatchObject({ date: day, time: t });
        else expect(day.endsWith('-03-29') || day.endsWith('-03-28')).toBe(true);
      }
    }
  });

  it('rejects junk', () => {
    expect(londonToUtc('2026-02-30', '09:00')).toEqual({ ok: false, reason: 'invalid' });
    expect(londonToUtc('2026-02-01', '24:00')).toEqual({ ok: false, reason: 'invalid' });
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isMonth('2026-00')).toBe(false);
    expect(isMonth('1999-12')).toBe(false);
  });

  it('does calendar arithmetic on dates', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(daysInMonth('2028-02')).toBe(29);
    expect(weekdayMon0('2026-10-12')).toBe(0);
    expect(weekdayMon0('2026-10-18')).toBe(6);
  });
});
