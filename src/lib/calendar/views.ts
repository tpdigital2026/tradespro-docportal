/**
 * Calendar views (month, week, agenda): which days they show and which appointments fall on each day. Pure.
 */
import { addDays, addMonths, daysInMonth, isIsoDate, isMonth, londonToUtc, monthOf, weekdayMon0 } from '../london';
import { daysCovered, type Appointment } from './model';

export type CalendarView = 'month' | 'week' | 'agenda';
/** auto: no view chosen, so the month shows on wide screens and the agenda on phones. */
export type ViewChoice = CalendarView | 'auto';

export const AGENDA_DAYS = 31;

export interface CalendarParams {
  view: ViewChoice;
  /** yyyy-mm for the month view. */
  month: string;
  /** yyyy-mm-dd for the week and agenda views. */
  day: string;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseCalendarParams(sp: Record<string, string | string[] | undefined>, today: string): CalendarParams {
  const v = one(sp.view);
  const view: ViewChoice = v === 'month' || v === 'week' || v === 'agenda' ? v : 'auto';
  const d = one(sp.d);
  const m = one(sp.m);
  const day = isIsoDate(d) && d >= '2000-01-01' && d < '2100-01-01' ? d : today;
  const month = isMonth(m) ? m : monthOf(day);
  return { view, month, day };
}

export const mondayOf = (iso: string) => addDays(iso, -weekdayMon0(iso));

/** The weeks (Monday to Sunday) a month grid shows. */
export function monthWeeks(month: string): string[][] {
  const firstDay = `${month}-01`;
  const lastDay = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const weeks: string[][] = [];
  for (let start = mondayOf(firstDay); start <= lastDay; start = addDays(start, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  return weeks;
}

export const weekDays = (day: string) => Array.from({ length: 7 }, (_, i) => addDays(mondayOf(day), i));
export const agendaDays = (from: string) => Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(from, i));

/** First and last London day a view needs. */
export function viewSpan(p: CalendarParams, view: CalendarView): { first: string; last: string } {
  if (view === 'month') {
    const w = monthWeeks(p.month);
    return { first: w[0][0], last: w[w.length - 1][6] };
  }
  if (view === 'week') {
    const d = weekDays(p.day);
    return { first: d[0], last: d[6] };
  }
  return { first: p.day, last: addDays(p.day, AGENDA_DAYS - 1) };
}

/** The instants from the start of `first` to the start of the day after `last`, London time. Midnight always exists. */
export function instantsFor(first: string, last: string): { from: Date; to: Date } {
  const a = londonToUtc(first, '00:00');
  const b = londonToUtc(addDays(last, 1), '00:00');
  if (!a.ok || !b.ok) throw new Error('Not a valid range');
  return { from: a.at, to: b.at };
}

/** Appointments by London day, each day's earliest first. A multi-day appointment appears on every day it covers. */
export function byDay(list: Appointment[]): Map<string, Appointment[]> {
  const m = new Map<string, Appointment[]>();
  for (const a of [...list].sort((x, y) => x.startsAt.localeCompare(y.startsAt) || x.id.localeCompare(y.id))) {
    for (const d of daysCovered(a)) {
      const arr = m.get(d) ?? [];
      arr.push(a);
      m.set(d, arr);
    }
  }
  return m;
}

export function calendarHref(p: { view?: ViewChoice; month?: string; day?: string }): string {
  const q = new URLSearchParams();
  if (p.view && p.view !== 'auto') q.set('view', p.view);
  if (p.view === 'month' && p.month) q.set('m', p.month);
  if ((p.view === 'week' || p.view === 'agenda') && p.day) q.set('d', p.day);
  const s = q.toString();
  return s ? `/calendar?${s}` : '/calendar';
}

export function stepHref(p: CalendarParams, view: CalendarView, dir: -1 | 1): string {
  if (view === 'month') return calendarHref({ view: 'month', month: addMonths(p.month, dir) });
  if (view === 'week') return calendarHref({ view: 'week', day: addDays(mondayOf(p.day), 7 * dir) });
  return calendarHref({ view: 'agenda', day: addDays(p.day, AGENDA_DAYS * dir) });
}
