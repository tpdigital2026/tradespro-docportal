/**
 * A business's writing voice for the scope of works: its own example bullets, worked examples of rough steps turned
 * into quote bullets, the section headings it uses, and the things its quotes always cover. They teach the assistant
 * the shape of the wording (imperative, short, trade words), never the facts of a job.
 *
 * Data rules, enforced by tests/unit/scope-voice.test.ts: no digits, no prices or pound signs, no phone numbers,
 * email addresses, postcodes or names of people or places, no brands other than generic material abbreviations; and
 * each worked example obeys the same checks as the live output (nothing in "wording" that the rough steps did not give).
 */
export interface VoiceGroup {
  heading: string | null;
  steps: string[];
}
export interface VoiceSection {
  /** Which input group these bullets come from (0-based). A group with no heading may become several sections. */
  group: number;
  heading: string;
  steps: string[];
}
export interface VoiceExample {
  /** What kind of job, in the business's own label words. */
  jobType: string;
  /** What an owner might type or dictate: typos, filler, mishearings. Made up. */
  rough: VoiceGroup[];
  /** The bullets as the business would write them, in the same order. */
  wording: VoiceSection[];
  corrections: string[];
  uncertain: string[];
}
export interface ReferenceBullets {
  jobType: string;
  bullets: string[];
  /** Fewer bullets than usual because there is no more real wording to draw on. Never padded. */
  shortOnPurpose?: boolean;
}
export interface ChecklistItem {
  key: string;
  /** Asked when none of `coveredBy` appears in the owner's steps. A question, never a statement. */
  question: string;
  /** Words that show the owner has already covered this (lowercase, matched on exact stems). */
  coveredBy: string[];
  /** Only for job types whose label contains one of these words (lowercase). Left out: every job type. */
  onlyFor?: string[];
}
export interface ScopeVoice {
  /** Bumped whenever the data changes, so a stored result can be traced to the voice that shaped it. */
  version: string;
  /** The section headings the business uses, in the order the work happens. Only used when the steps clearly fit. */
  headings: readonly string[];
  /** The business's own example bullets per kind of job: style only, never content. */
  referenceBullets: readonly ReferenceBullets[];
  examples: readonly VoiceExample[];
  /** What the business's quotes always cover. Missing ones become "Things you could add" questions. */
  checklist: readonly ChecklistItem[];
}
