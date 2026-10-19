import { cleanLine } from '../lib/scope/model';
import type { ScopeExamples } from '../lib/scope/examples';
import { sameStepKey } from '../lib/scope/tidy';
import { contentStems } from './facts';
import { MAX_SUGGESTIONS } from './schemas';
import { stemCandidates } from './vocab/stems';
import type { ChecklistItem } from './voices/types';

/**
 * "Things you could add": questions for the owner about what the business's quotes always cover (its checklist:
 * access, waste, protection, roof area, guarantee, extras) and about its usual steps for this kind of job, when the
 * owner's steps say nothing about them. Worked out here, never by the model, so they can only ever be the business's
 * own questions. They are questions, never statements, and never part of the wording. One tap on "Add a step" adds a
 * step (the usual step's text, or an empty one) to the owner's steps; the wording then has to be made again.
 */
export interface ScopeSuggestion {
  question: string;
  /** The usual step this question comes from, exactly as the business wrote it. Null: the tap adds an empty step. */
  step: string | null;
}

/** The business's usual steps for a job type: the typical sequence first, then the one-tap starters. No repeats. */
export function typicalStepsFrom(examples: ScopeExamples | null | undefined, max = 40): string[] {
  if (!examples) return [];
  const all = [...examples.sequences.flatMap((s) => s.sections.flatMap((x) => x.steps)), ...examples.starters.flatMap((s) => s.steps)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of all) {
    const t = cleanLine(raw);
    const k = sameStepKey(t);
    if (t === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Every word the owner wrote, as exact stems and suffix bases (all words, including short ones like "m"). */
function ownerWordStems(ownerTexts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of ownerTexts) for (const m of t.normalize('NFKC').matchAll(/[\p{L}\p{M}]+/gu)) for (const c of stemCandidates(m[0])) out.add(c);
  return out;
}

/** Has the owner already covered this usual step? A content word of four letters or more in common counts. */
export function covered(step: string, ownerStems: ReadonlySet<string>): boolean {
  for (const s of contentStems(step)) if (s.length >= 4 && ownerStems.has(s)) return true;
  return false;
}

export interface SuggestionContext {
  /** Everything the owner wrote (steps and headings). */
  ownerTexts: readonly string[];
  jobType: string;
  checklist: readonly ChecklistItem[];
  typicalSteps: readonly string[];
}

const lowerFirst = (s: string) => (/^\p{Lu}\p{Ll}/u.test(s) ? s.charAt(0).toLocaleLowerCase('en-GB') + s.slice(1) : s);

export function suggestionsFor(ctx: SuggestionContext, max = MAX_SUGGESTIONS): ScopeSuggestion[] {
  const words = ownerWordStems(ctx.ownerTexts);
  const job = ctx.jobType.toLocaleLowerCase('en-GB');
  const out: ScopeSuggestion[] = [];
  for (const item of ctx.checklist) {
    if (item.onlyFor && !item.onlyFor.some((w) => job.includes(w))) continue;
    if (item.coveredBy.some((w) => words.has(w))) continue;
    out.push({ question: item.question, step: null });
    if (out.length >= max) return out;
  }
  const stems = new Set<string>();
  for (const t of ctx.ownerTexts) for (const s of contentStems(t)) stems.add(s);
  for (const step of ctx.typicalSteps) {
    if (covered(step, stems)) continue;
    out.push({ question: `Do you need a step to ${lowerFirst(step.replace(/[.\s]+$/, ''))}?`, step });
    if (out.length >= max) break;
  }
  return out;
}
