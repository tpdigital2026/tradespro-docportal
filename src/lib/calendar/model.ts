/**
 * Appointments: the form rules (zod) and the shapes the calendar views use. Pure.
 *
 * Times are typed as UK wall-clock time (Europe/London) and stored as instants (timestamptz), so a visit at 09:00 stays
 * at 09:00 whichever side of a clock change it falls. No reminders, no notifications.
 */
import { z } from 'zod';
import { isIsoDate, isTime, londonParts, londonToUtc } from '../london';

export const APPOINTMENT_KINDS = [
  { key: 'site_visit', label: 'Site visit' },
  { key: 'survey', label: 'Survey' },
  { key: 'job_start', label: 'Job start' },
  { key: 'job_finish', label: 'Job finish' },
  { key: 'other', label: 'Other' },
] as const;
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number]['key'];
export const KIND_KEYS = APPOINTMENT_KINDS.map((k) => k.key) as [AppointmentKind, ...AppointmentKind[]];
export const kindLabel = (k: string) => APPOINTMENT_KINDS.find((x) => x.key === k)?.label ?? 'Other';

export const TITLE_MAX = 120;
export const NOTES_MAX = 1000;
/** The longest an appointment may run: two weeks covers a long job. */
export const MAX_SPAN_DAYS = 14;

export interface Appointment {
  id: string;
  kind: AppointmentKind;
  title: string;
  /** ISO instant */
  startsAt: string;
  endsAt: string | null;
  customerId: string | null;
  customerName: string | null;
  jobId: string | null;
  quoteNumber: string | null;
  notes: string | null;
}

export interface AppointmentFormValues {
  kind: string;
  title: string;
  date: string;
  start: string;
  endDate: string;
  end: string;
  customerId: string;
  jobId: string;
  notes: string;
}

export type AppointmentErrors = Partial<Record<keyof AppointmentFormValues | 'form', string>>;

export interface AppointmentInput {
  kind: AppointmentKind;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  customerId: string | null;
  jobId: string | null;
  notes: string | null;
}

/** Plain text: control characters out (line breaks kept in notes), spacing tidied, NFC. */
function clean(s: string, multiline: boolean): string {
  const t = s.normalize('NFC').replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, multiline ? '' : ' ');
  return multiline ? t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : t.replace(/\s+/g, ' ').trim();
}

const id = z.union([z.literal(''), z.string().max(80).regex(/^[A-Za-z0-9-]+$/)]);

const schema = z.strictObject({
  kind: z.enum(KIND_KEYS, { error: 'Choose what kind of appointment this is' }),
  title: z.string().transform((s) => clean(s, false)).pipe(z.string().min(1, 'Give it a short title').max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters`)),
  date: z.string().refine(isIsoDate, 'Choose a date'),
  start: z.string().refine(isTime, 'Choose a start time'),
  endDate: z.union([z.literal(''), z.string().refine(isIsoDate, 'Choose a real end date')]),
  end: z.union([z.literal(''), z.string().refine(isTime, 'Choose a real end time')]),
  customerId: id,
  jobId: id,
  notes: z.string().transform((s) => clean(s, true)).pipe(z.string().max(NOTES_MAX, `Keep the notes under ${NOTES_MAX} characters`)),
});

export type Checked = { ok: true; value: AppointmentInput } | { ok: false; errors: AppointmentErrors };

const SKIPPED = 'That time does not exist on this date because the clocks go forward. Choose another time.';

export function checkAppointment(raw: unknown): Checked {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const errors: AppointmentErrors = {};
    for (const issue of r.error.issues) {
      const key = (issue.path[0] as keyof AppointmentFormValues | undefined) ?? 'form';
      errors[key] ??= issue.message;
    }
    return { ok: false, errors };
  }
  const v = r.data;
  const start = londonToUtc(v.date, v.start);
  if (!start.ok) return { ok: false, errors: { start: start.reason === 'skipped' ? SKIPPED : 'Choose a start time' } };
  let endsAt: Date | null = null;
  if (v.end) {
    const end = londonToUtc(v.endDate || v.date, v.end);
    if (!end.ok) return { ok: false, errors: { end: end.reason === 'skipped' ? SKIPPED : 'Choose a real end time' } };
    if (end.at.getTime() <= start.at.getTime()) return { ok: false, errors: { end: 'The end must be after the start' } };
    if (end.at.getTime() - start.at.getTime() > MAX_SPAN_DAYS * 86_400_000) return { ok: false, errors: { end: `An appointment can last up to ${MAX_SPAN_DAYS} days` } };
    endsAt = end.at;
  } else if (v.endDate && v.endDate !== v.date) {
    return { ok: false, errors: { end: 'Add an end time for the end date' } };
  }
  return {
    ok: true,
    value: { kind: v.kind, title: v.title, startsAt: start.at, endsAt, customerId: v.customerId || null, jobId: v.jobId || null, notes: v.notes || null },
  };
}

/** The form's values for an existing appointment (London wall time). */
export function formValuesOf(a: Appointment): AppointmentFormValues {
  const s = londonParts(new Date(a.startsAt));
  const e = a.endsAt ? londonParts(new Date(a.endsAt)) : null;
  return { kind: a.kind, title: a.title, date: s.date, start: s.time, endDate: e && e.date !== s.date ? e.date : '', end: e?.time ?? '', customerId: a.customerId ?? '', jobId: a.jobId ?? '', notes: a.notes ?? '' };
}

/** "09:00", "09:00 to 11:30", "09:00 to 16 Oct, 17:00" */
export function timeRange(a: Pick<Appointment, 'startsAt' | 'endsAt'>): string {
  const s = londonParts(new Date(a.startsAt));
  if (!a.endsAt) return s.time;
  const e = londonParts(new Date(a.endsAt));
  if (e.date === s.date) return `${s.time} to ${e.time}`;
  const d = new Date(`${e.date}T00:00:00Z`);
  return `${s.time} to ${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}, ${e.time}`;
}

/** The London calendar days an appointment covers (start day to end day). */
export function daysCovered(a: Pick<Appointment, 'startsAt' | 'endsAt'>): string[] {
  const s = londonParts(new Date(a.startsAt)).date;
  // An end at exactly midnight does not spill into the next day.
  const e = a.endsAt ? londonParts(new Date(Math.max(Date.parse(a.startsAt), Date.parse(a.endsAt) - 60_000))).date : s;
  const out: string[] = [];
  for (let d = s; d <= e && out.length <= MAX_SPAN_DAYS + 1; ) {
    out.push(d);
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    d = t.toISOString().slice(0, 10);
  }
  return out;
}
