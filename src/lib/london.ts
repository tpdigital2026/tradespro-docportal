/**
 * UK calendar dates and wall-clock times (Europe/London), worked out with Intl so the clock changes are right.
 * Pure. Dates are 'yyyy-mm-dd' strings, times 'hh:mm'; instants are Date objects (UTC inside).
 */
import { todayLondon } from './payment';

export { todayLondon };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface LondonParts {
  date: string;
  time: string;
  /** Minutes London is ahead of UTC at that instant: 0 in winter, 60 in summer. */
  offsetMinutes: number;
}

/** The London calendar date, wall time and offset of an instant. */
export function londonParts(at: Date): LondonParts {
  const p = Object.fromEntries(PARTS.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offsetMinutes = Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  return { date, time, offsetMinutes };
}

/** The London calendar date of an instant (or an ISO timestamp). */
export function londonDate(at: Date | string): string {
  return londonParts(typeof at === 'string' ? new Date(at) : at).date;
}

/** True when the string is a real calendar date. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export const isTime = (s: unknown): s is string => typeof s === 'string' && TIME_RE.test(s);

const toUtcDay = (iso: string) => {
  const m = DATE_RE.exec(iso)!;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};
const fromUtcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(iso: string, n: number): string {
  return fromUtcDay(toUtcDay(iso) + n * 86_400_000);
}

/** Whole days from a to b (b later gives a positive number). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcDay(b) - toUtcDay(a)) / 86_400_000);
}

/** 0 = Monday ... 6 = Sunday, the UK week. */
export function weekdayMon0(iso: string): number {
  return (new Date(toUtcDay(iso)).getUTCDay() + 6) % 7;
}

export const monthOf = (iso: string) => iso.slice(0, 7);
export const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && Number(s.slice(0, 4)) >= 2000 && Number(s.slice(0, 4)) <= 2100;

export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}

export function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export type LocalToUtc = { ok: true; at: Date } | { ok: false; reason: 'invalid' | 'skipped' };

/**
 * A London wall-clock date and time to the instant it names. In the hour the clocks go forward (late March) times
 * such as 01:30 do not exist: refused as 'skipped'. In the hour the clocks go back (late October) 01:30 happens
 * twice: the first one (British Summer Time) is taken.
 */
export function londonToUtc(date: string, time: string): LocalToUtc {
  if (!isIsoDate(date) || !isTime(time)) return { ok: false, reason: 'invalid' };
  const [h, mi] = time.split(':').map(Number);
  const wall = toUtcDay(date) + (h * 60 + mi) * 60_000;
  // Try both possible offsets, earliest instant first; keep the one that reads back as the same wall time.
  for (const offset of [60, 0]) {
    const at = new Date(wall - offset * 60_000);
    const back = londonParts(at);
    if (back.date === date && back.time === time) return { ok: true, at };
  }
  return { ok: false, reason: 'skipped' };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** "October 2026" */
export function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}
/** "15 Oct 2026", or "15 Oct" when short. */
export function shortDate(iso: string, withYear = true): string {
  const d = new Date(toUtcDay(iso));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}${withYear ? ` ${d.getUTCFullYear()}` : ''}`;
}
/** "Thursday 15 October" */
export function dayLabel(iso: string, withYear = false): string {
  const d = new Date(toUtcDay(iso));
  return `${DAYS[weekdayMon0(iso)]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ''}`;
}
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAY_LONG = DAYS;
