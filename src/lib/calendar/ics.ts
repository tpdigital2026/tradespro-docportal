/**
 * iCalendar (RFC 5545) files so the owner can add appointments to the calendar on their phone. Pure.
 *
 * Times are written in UTC (the 'Z' form), converted from the stored instants, so no VTIMEZONE is needed and the clock
 * changes cannot shift anything. Text is escaped (backslash, semicolon, comma, line breaks) and lines are folded at 75
 * octets without splitting a character. Only what the owner typed goes in: the title and the notes. No customer name,
 * address, phone or email is added.
 */

export interface IcsEvent {
  /** Stable id: the same appointment always has the same UID, so importing it again updates instead of duplicating. */
  id: string;
  title: string;
  startsAt: string | Date;
  endsAt: string | Date | null;
  notes: string | null;
  /** When the appointment was last changed: DTSTAMP, and the SEQUENCE that makes an edited copy replace the old one. */
  stamp: string | Date;
}

const SEQUENCE_EPOCH = Date.UTC(2020, 0, 1);

/** Seconds since 2020 of the last change: rises with every edit, fits a 32-bit integer until 2088. */
export function sequenceOf(stamp: string | Date): number {
  const t = (typeof stamp === 'string' ? new Date(stamp) : stamp).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((t - SEQUENCE_EPOCH) / 1000)) : 0;
}

export const ICS_DOMAIN = 'docs.tradesprodigital.io';
const PRODID = '-//TradesPro Digital//DocPortal//EN';

/** TEXT value escaping (RFC 5545 3.3.11). Control characters other than line breaks are dropped. */
export function escapeText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** 20261015T080000Z */
export function utcStamp(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) throw new Error('Not a valid time');
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const enc = new TextEncoder();

/** Folds one content line at 75 octets (RFC 5545 3.1), never inside a UTF-8 character. */
export function foldLine(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      parts.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74; // continuation lines start with a space, which counts
    }
    cur += ch;
    curBytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

/** A UID part made only of safe characters. */
const uidOf = (id: string) => `${id.replace(/[^A-Za-z0-9-]/g, '')}@${ICS_DOMAIN}`;

function eventLines(e: IcsEvent): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${uidOf(e.id)}`, `DTSTAMP:${utcStamp(e.stamp)}`, `SEQUENCE:${sequenceOf(e.stamp)}`, `DTSTART:${utcStamp(e.startsAt)}`];
  if (e.endsAt) lines.push(`DTEND:${utcStamp(e.endsAt)}`);
  lines.push(`SUMMARY:${escapeText(e.title)}`);
  if (e.notes && e.notes.trim()) lines.push(`DESCRIPTION:${escapeText(e.notes)}`);
  lines.push('END:VEVENT');
  return lines;
}

/** A whole calendar file. calName labels the calendar when it is imported as one ("Appointments, October 2026"). */
export function buildIcs(events: IcsEvent[], calName?: string): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (calName) lines.push(`X-WR-CALNAME:${escapeText(calName)}`);
  for (const e of events) lines.push(...eventLines(e));
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** A filename made only of safe characters. */
export function icsFilename(base: string): string {
  const s = base.normalize('NFKD').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${s || 'appointment'}.ics`;
}
