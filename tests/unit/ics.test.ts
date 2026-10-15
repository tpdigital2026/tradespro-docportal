import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { buildIcs, escapeText, foldLine, icsFilename, utcStamp, type IcsEvent } from '../../src/lib/calendar/ics';
import { londonToUtc } from '../../src/lib/london';

const enc = new TextEncoder();

function parse(text: string) {
  const comp = new ICAL.Component(ICAL.parse(text));
  return comp.getAllSubcomponents('vevent').map((v) => ({
    uid: String(v.getFirstPropertyValue('uid')),
    summary: String(v.getFirstPropertyValue('summary')),
    description: v.getFirstPropertyValue('description') as string | null,
    start: (v.getFirstPropertyValue('dtstart') as ICAL.Time).toJSDate(),
    end: v.hasProperty('dtend') ? (v.getFirstPropertyValue('dtend') as ICAL.Time).toJSDate() : null,
    keys: v.getAllProperties().map((p) => p.name),
  }));
}

const at = (d: string, t: string) => {
  const r = londonToUtc(d, t);
  if (!r.ok) throw new Error('bad time');
  return r.at.toISOString();
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['a', 'Z', ' ', ',', ';', '\\', '\n', '\r\n', ':', '"', "'", 'é', '£', '😀', '\u0007', '\t', 'ß', '中', '=', '-'];

describe('ics', () => {
  it('writes a calendar a real parser reads back exactly', () => {
    const e: IcsEvent = { id: '6f1e2b0c-1111-4222-8333-944455556666', title: 'Survey, roof; back', startsAt: at('2026-07-01', '09:00'), endsAt: at('2026-07-01', '10:30'), notes: 'Line one\nLine two, with \\ and ;', stamp: '2026-06-01T12:00:00Z' };
    const text = buildIcs([e], 'Appointments, July 2026');
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
    const [ev] = parse(text);
    expect(ev.uid).toBe('6f1e2b0c-1111-4222-8333-944455556666@docs.tradesprodigital.io');
    expect(ev.summary).toBe(e.title);
    expect(ev.description).toBe(e.notes);
    expect(ev.start.toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(ev.end?.toISOString()).toBe('2026-07-01T09:30:00.000Z');
    expect(text).toContain('DTSTART:20260701T080000Z');
  });

  it('converts across the clock changes correctly (UTC times, no floating times)', () => {
    const events: IcsEvent[] = [
      { id: 'a', title: 'Before spring change', startsAt: at('2026-03-29', '00:30'), endsAt: at('2026-03-29', '03:00'), notes: null, stamp: '2026-03-01T00:00:00Z' },
      { id: 'b', title: 'Repeated hour', startsAt: at('2026-10-25', '01:30'), endsAt: at('2026-10-25', '02:30'), notes: null, stamp: '2026-03-01T00:00:00Z' },
      { id: 'c', title: 'Winter', startsAt: at('2026-12-01', '09:00'), endsAt: null, notes: null, stamp: '2026-03-01T00:00:00Z' },
    ];
    const text = buildIcs(events);
    expect(text).toContain('DTSTART:20260329T003000Z');
    expect(text).toContain('DTEND:20260329T020000Z'); // 03:00 BST is 02:00 UTC: a 1.5 hour slot
    expect(text).toContain('DTSTART:20261025T003000Z'); // the first 01:30 (BST)
    expect(text).toContain('DTEND:20261025T023000Z'); // 02:30 GMT
    expect(text).toContain('DTSTART:20261201T090000Z');
    const parsed = parse(text);
    expect((parsed[0].end!.getTime() - parsed[0].start.getTime()) / 60000).toBe(90);
    expect((parsed[1].end!.getTime() - parsed[1].start.getTime()) / 60000).toBe(120);
    expect(parsed[2].end).toBeNull();
    expect(text).not.toMatch(/DTSTART(;|:)\d{8}T\d{6}\r/); // never a floating local time
  });

  it('puts nothing in but the title, time and notes', () => {
    const text = buildIcs([{ id: 'x', title: 'Visit', startsAt: '2026-07-01T08:00:00Z', endsAt: null, notes: 'Bring ladder', stamp: '2026-06-01T00:00:00Z' }]);
    const [ev] = parse(text);
    expect(ev.keys.sort()).toEqual(['description', 'dtstamp', 'dtstart', 'summary', 'uid']);
    expect(text).not.toMatch(/LOCATION|ATTENDEE|ORGANIZER|ALARM|VALARM/);
  });

  it('escapes text per RFC 5545', () => {
    expect(escapeText('a,b;c\\d\ne\r\nf')).toBe('a\\,b\\;c\\\\d\\ne\\nf');
    expect(escapeText('bell\u0007 tab\t')).toBe('bell tab');
  });

  it('folds long lines at 75 octets without splitting a character', () => {
    const line = `SUMMARY:${'é😀£'.repeat(40)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) expect(enc.encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
    expect(foldLine('SHORT:x')).toBe('SHORT:x');
  });

  it('property: any typed title and notes survive a parse unchanged (apart from dropped control characters)', () => {
    const r = rng(20261015);
    for (let n = 0; n < 300; n += 1) {
      const pick = (len: number) => Array.from({ length: len }, () => ALPHABET[Math.floor(r() * ALPHABET.length)]).join('');
      const title = pick(1 + Math.floor(r() * 120));
      const notes = r() < 0.3 ? null : pick(Math.floor(r() * 400));
      // Random London times across several years, clock-change days included.
      const day = new Date(Date.UTC(2025 + Math.floor(r() * 4), Math.floor(r() * 12), 1 + Math.floor(r() * 28))).toISOString().slice(0, 10);
      const start = londonToUtc(day, `${String(Math.floor(r() * 24)).padStart(2, '0')}:${String(Math.floor(r() * 4) * 15).padStart(2, '0')}`);
      if (!start.ok) continue;
      const end = r() < 0.5 ? null : new Date(start.at.getTime() + Math.floor(1 + r() * 600) * 60000);
      const text = buildIcs([{ id: `id-${n}`, title, startsAt: start.at, endsAt: end, notes, stamp: '2026-01-01T00:00:00Z' }]);
      for (const line of text.split('\r\n')) expect(enc.encode(line).length).toBeLessThanOrEqual(75);
      const [ev] = parse(text);
      const expected = (s: string) => s.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
      expect(ev.summary).toBe(expected(title));
      if (notes && notes.trim()) expect(ev.description).toBe(expected(notes));
      expect(ev.start.getTime()).toBe(start.at.getTime());
      if (end) expect(ev.end!.getTime()).toBe(end.getTime());
    }
  });

  it('stamps and filenames', () => {
    expect(utcStamp('2026-10-15T08:05:09.123Z')).toBe('20261015T080509Z');
    expect(() => utcStamp('nonsense')).toThrow();
    expect(icsFilename('Roof survey: Mr "Smith" / 9am')).toBe('Roof-survey-Mr-Smith-9am.ics');
    expect(icsFilename('😀')).toBe('appointment.ics');
  });
});
