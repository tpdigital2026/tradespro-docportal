/**
 * The guarantee certificate's form: roof types, the years that go with each, and every rule on what may be entered.
 * Pure (no I/O), so the browser, the server and the tests all use the same rules.
 *
 * Truth rules: nothing is guessed. The completion date has no default and may not be in the future; the issue date is
 * always today (London), never typed and never backdated. The years default only for the roof types the business has
 * told us about (flat 20, tiled 25, dormer flat roof 20); any other roof type has no default and the owner must say.
 */
import { isIsoDate } from '../london';
import { MAX_GUARANTEES_PER_JOB } from '../job-stage';
import { jobStem } from '../doc-numbers';
import { NUMBER_RE } from '../validation/quote';
import { tidyLine } from '../survey/model';

export const ROOF_TYPES = [
  { key: 'flat', label: 'Flat roof', words: 'flat roof', defaultYears: 20 },
  { key: 'tiled', label: 'Tiled roof', words: 'tiled roof', defaultYears: 25 },
  { key: 'dormer', label: 'Dormer flat roof', words: 'dormer flat roof', defaultYears: 20 },
  { key: 'pitched', label: 'Pitched roof', words: 'pitched roof', defaultYears: null },
  { key: 'other', label: 'Other', words: '', defaultYears: null },
] as const;

export type RoofKey = (typeof ROOF_TYPES)[number]['key'];
export const isRoofKey = (s: unknown): s is RoofKey => ROOF_TYPES.some((r) => r.key === s);

export const GUARANTEE_LIMITS = { years: { min: 1, max: 50 }, roofOther: 60, address: 200, linkedQuote: 40 } as const;

export interface GuaranteeValues {
  roofType: RoofKey | '';
  /** Only used when roofType is 'other': what the roof is called on the certificate. */
  roofOther: string;
  /** As typed; a whole number from 1 to 50 once finished. */
  years: string;
  address: string;
  /** yyyy-mm-dd: when the installation was really completed. Empty until the owner says. */
  completedOn: string;
  /** The quote this certificate is for (optional). */
  linkedQuote: string;
}

export function emptyGuarantee(defaults: Partial<GuaranteeValues> = {}): GuaranteeValues {
  return { roofType: '', roofOther: '', years: '', address: '', completedOn: '', linkedQuote: '', ...defaults };
}

export const roofDefinition = (k: RoofKey | '') => ROOF_TYPES.find((r) => r.key === k) ?? null;

/** The years a roof type starts with, as the text of the years box ('' when the business has no standard for it). */
export function defaultYearsText(k: RoofKey | ''): string {
  const d = roofDefinition(k)?.defaultYears ?? null;
  return d === null ? '' : String(d);
}

/** What the certificate says the work is: "tiled roof", or the other roof as typed. '' until it is known. */
export function roofWords(v: Pick<GuaranteeValues, 'roofType' | 'roofOther'>): string {
  if (v.roofType === 'other') return tidyLine(v.roofOther).slice(0, GUARANTEE_LIMITS.roofOther);
  return roofDefinition(v.roofType)?.words ?? '';
}

/** How the roof is named in lists: "Tiled roof", or the other roof as typed. */
export function roofLabel(v: Pick<GuaranteeValues, 'roofType' | 'roofOther'>): string {
  if (v.roofType === 'other') return tidyLine(v.roofOther);
  return roofDefinition(v.roofType)?.label ?? '';
}

/**
 * Which roof a certificate is for, as a key the database compares: one certificate per key per job. Another roof is
 * compared by its words (case, spacing and punctuation ignored), so "Garage roof" and "garage  roof." are the same roof.
 */
export function roofKeyOf(v: Pick<GuaranteeValues, 'roofType' | 'roofOther'>): string {
  if (v.roofType === '') return '';
  if (v.roofType !== 'other') return v.roofType;
  const text = tidyLine(v.roofOther).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return text ? `other:${text}` : '';
}

/** A whole number of years from 1 to 50, or null. */
export function parseYears(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= GUARANTEE_LIMITS.years.min && n <= GUARANTEE_LIMITS.years.max ? n : null;
}

export type GuaranteeErrors = Partial<Record<keyof GuaranteeValues, string>>;

/** Every problem that stops a certificate being issued, one message per box. today is the London date. */
export function guaranteeErrors(v: GuaranteeValues, today: string): GuaranteeErrors {
  const e: GuaranteeErrors = {};
  if (v.roofType === '') e.roofType = 'Choose the type of roof.';
  else if (v.roofType === 'other' && tidyLine(v.roofOther) === '') e.roofOther = 'Say what the roof is, for example "garage roof".';
  if (v.years.trim() === '') e.years = 'Enter how many years the guarantee lasts.';
  else if (parseYears(v.years) === null) e.years = `Enter a whole number of years from ${GUARANTEE_LIMITS.years.min} to ${GUARANTEE_LIMITS.years.max}.`;
  if (tidyLine(v.address) === '') e.address = 'Enter the address of the roof.';
  if (v.completedOn === '') e.completedOn = 'Enter the date the installation was completed.';
  else if (!isIsoDate(v.completedOn)) e.completedOn = 'Enter a real date.';
  else if (v.completedOn > today) e.completedOn = 'The installation cannot be completed in the future. Use the date the work was really finished.';
  else if (v.completedOn < '1990-01-01') e.completedOn = 'That date looks too long ago. Check the year.';
  const q = v.linkedQuote.trim();
  if (q !== '' && !NUMBER_RE.test(q)) e.linkedQuote = 'A quote number is 2 to 40 letters, numbers, dots, dashes or slashes.';
  return e;
}

/** The values as they are kept: tidy lines, the roof only when it applies, nothing longer than its limit. */
export function tidyGuarantee(v: GuaranteeValues): GuaranteeValues {
  return {
    roofType: isRoofKey(v.roofType) ? v.roofType : '',
    roofOther: v.roofType === 'other' ? tidyLine(v.roofOther).slice(0, GUARANTEE_LIMITS.roofOther) : '',
    years: v.years.replace(/\s+/g, '').slice(0, 3),
    address: tidyLine(v.address).slice(0, GUARANTEE_LIMITS.address),
    completedOn: v.completedOn.trim().slice(0, 10),
    linkedQuote: v.linkedQuote.trim().slice(0, GUARANTEE_LIMITS.linkedQuote),
  };
}

/** The saved shape of a draft (a version's input), with the roof key the database checks. */
export const storedGuarantee = (v: GuaranteeValues) => ({ schema: 1, guarantee: { ...v, roofKey: roofKeyOf(v) } });

/** Reads a version's input back into values, or null when it holds none. */
export function parseGuaranteeInput(input: unknown): GuaranteeValues | null {
  const g = (input as { guarantee?: Record<string, unknown> } | null)?.guarantee;
  if (!g || typeof g !== 'object') return null;
  const s = (x: unknown) => (typeof x === 'string' ? x : '');
  return tidyGuarantee({ roofType: isRoofKey(g.roofType) ? g.roofType : '', roofOther: s(g.roofOther), years: s(g.years), address: s(g.address), completedOn: s(g.completedOn), linkedQuote: s(g.linkedQuote) });
}

/** The first free place among a job's certificates, from the numbers already used (GC-{q}, GC-{q}-G2 ...). null when there are none left. */
export function nextCertificateSeq(reference: string, usedNumbers: readonly string[]): number | null {
  const used = new Set(usedNumbers);
  // GC-{code}-{number}: built from the quote number's stem, so QT-GW-001 gives GC-GW-001 (not GC-QT-GW-001). A certificate numbered the
  // older way (GC-QT-GW-001) still holds its place.
  const stems = [...new Set([jobStem(reference), reference])];
  for (let seq = 1; seq <= MAX_GUARANTEES_PER_JOB; seq += 1) {
    if (!stems.some((stem) => used.has(seq === 1 ? `GC-${stem}` : `GC-${stem}-G${seq}`))) return seq;
  }
  return null;
}
