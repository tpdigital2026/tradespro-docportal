/** How long customer data is kept, shown to the owner. Pure: no I/O. */

export const DEFAULT_RETENTION_DAYS = 90;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 730;
/** From this many days left the screen warns and offers to keep the data longer. */
export const RETENTION_WARNING_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left, rounded up, never below zero. */
export function daysLeft(purgeAt: Date | string, now: Date): number {
  const ms = new Date(purgeAt).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil(ms / DAY_MS));
}

export function isRunningOut(days: number): boolean {
  return days <= RETENTION_WARNING_DAYS;
}

/** Accepts only a value the database would accept; anything else is the default. */
export function safeRetentionDays(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_RETENTION_DAYS && value <= MAX_RETENTION_DAYS
    ? value
    : DEFAULT_RETENTION_DAYS;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

export function formatKeptUntil(purgeAt: Date | string): string {
  const d = new Date(purgeAt);
  return Number.isFinite(d.getTime()) ? dateFmt.format(d) : '';
}

const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });

/** Compact form for list rows, so it stays on one line at phone width. */
export function formatKeptUntilShort(purgeAt: Date | string): string {
  const d = new Date(purgeAt);
  return Number.isFinite(d.getTime()) ? shortFmt.format(d) : '';
}
