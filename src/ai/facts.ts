import { stripInvisible } from '../lib/scope/invisible';
import { pluralStem, stemCandidates } from './vocab/stems';
import { UNIT_WORDS } from './vocab/units';

/**
 * Two guards that sit beside the invention check (they never replace or relax it). Both only ever reject wording,
 * which sends the owner to the basic tidy: the safe direction.
 *
 * 1. Kept facts: every figure the owner wrote is still there, with its unit when it had one ("12 hours" stays
 *    "12 hours"), and every name they capitalised mid-sentence is still there.
 * 2. No added work: a bullet whose content words are almost all new (none shared with the owner's steps) is new
 *    work, whatever it says ("Lay protection to floors and walls" when the owner never mentioned any of it).
 */

const norm = (t: string) => stripInvisible(t).normalize('NFKC');
const WORD = /[\p{L}\p{M}]+/gu;
const UNITS = new Set(UNIT_WORDS);

export interface MissingFact {
  kind: 'number' | 'figure' | 'name';
  text: string;
}

/** Figures, each with the unit word straight after it when there is one ("12 hours", "6-inch" gives 6 + inch). */
function figures(text: string): { n: string; unit: string | null }[] {
  const out: { n: string; unit: string | null }[] = [];
  for (const m of norm(text).matchAll(/(\p{Nd}+(?:[.,]\p{Nd}+)*)(?:\s*-?\s*([\p{L}]+))?/gu)) {
    const n = m[1]!.replace(/,/g, '');
    const w = m[2] ? pluralStem(m[2]) : null;
    out.push({ n, unit: w && UNITS.has(w) ? w : null });
  }
  return out;
}

/** Capitalised words that are not at the start of a sentence: names of people and places. */
function names(text: string): string[] {
  return [...norm(text).matchAll(/(?<=[\p{L}\p{M}\p{Nd},;:)]\s+)\p{Lu}[\p{Ll}\p{M}]+/gu)].map((m) => m[0]);
}

/**
 * Figures and names from the owner's text that the output lost. A capitalised word that the corrections list says was
 * read as something else ("Read 'Harris rails' as 'arris rails'") is a correction, not a lost name. Figures are
 * never excused.
 */
export function missingFacts(inputTexts: readonly string[], outputTexts: readonly string[], corrections: readonly string[] = []): MissingFact[] {
  const out = outputTexts.join('\n');
  const corrected = new Set<string>();
  for (const c of corrections) {
    const m = /^Read '([^']+)' as/u.exec(c.trim());
    if (m) for (const w of m[1]!.matchAll(WORD)) corrected.add(w[0].toLocaleLowerCase('en-GB'));
  }
  const outFigures = figures(out);
  const outWords = new Set([...norm(out).matchAll(WORD)].map((m) => m[0].toLocaleLowerCase('en-GB')));
  const missing: MissingFact[] = [];
  const seen = new Set<string>();
  for (const t of inputTexts) {
    for (const f of figures(t)) {
      const key = `${f.n} ${f.unit ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!outFigures.some((o) => o.n === f.n)) missing.push({ kind: 'number', text: f.n });
      else if (f.unit && !outFigures.some((o) => o.n === f.n && o.unit === f.unit)) missing.push({ kind: 'figure', text: `${f.n} ${f.unit}` });
    }
    for (const n of names(t)) {
      const lower = n.toLocaleLowerCase('en-GB');
      if (seen.has(`name:${lower}`)) continue;
      seen.add(`name:${lower}`);
      if (!outWords.has(lower) && !corrected.has(lower)) missing.push({ kind: 'name', text: n });
    }
  }
  return missing;
}

/**
 * Words that carry no content of their own here: grammar, and the plain verbs and adjectives a quote bullet opens
 * with. Data only. A bullet made of these plus one new noun is a rewording; two or more new nouns and nothing shared
 * is new work.
 */
export const GLUE_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'all', 'any', 'new', 'old', 'existing', 'original', 'with', 'for', 'from', 'into', 'onto', 'where', 'needed', 'need', 'needs', 'will',
  'are', 'our', 'your', 'this', 'that', 'then', 'them', 'they', 'their', 'off', 'out', 'back', 'over', 'also', 'make', 'sure', 'going', 'get', 'put',
  'take', 'away', 'there', 'here', 'its', 'not', 'but', 'have', 'has', 'been', 'being', 'can', 'each', 'every', 'some', 'whole', 'full', 'fully',
  'install', 'remove', 'fit', 'strip', 'replace', 'erect', 'strike', 'lay', 'provide', 'supply', 'inspect', 'check', 'clear', 'deliver', 'dispose',
  'carry', 'apply', 'fix', 'renew', 'repair', 'create', 'clean', 'seal', 'cut', 'set', 'tidy', 'sort', 'prepare', 'form', 'finish', 'complete',
  'site', 'work', 'works', 'job', 'area', 'side', 'end', 'start', 'ready', 'down', 'round', 'around', 'along', 'across', 'which', 'what', 'when',
  'any', 'than', 'such', 'other', 'same', 'like', 'just', 'very', 'well', 'good', 'condition', 'before', 'after', 'once', 'while', 'during',
]);

/** Content stems of a text: words of three letters or more that are not glue, with their exact suffix bases. */
export function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of norm(text).matchAll(WORD)) {
    const w = m[0].toLocaleLowerCase('en-GB');
    if (w.length < 3 || GLUE_WORDS.has(w) || GLUE_WORDS.has(pluralStem(w))) continue;
    for (const c of stemCandidates(w)) out.add(c);
  }
  return out;
}

/** The content words of a bullet that the owner never wrote in any form. */
function newContent(bullet: string, inputStems: ReadonlySet<string>): { fresh: string[]; shared: number } {
  const fresh: string[] = [];
  let shared = 0;
  for (const m of norm(bullet).matchAll(WORD)) {
    const w = m[0].toLocaleLowerCase('en-GB');
    if (w.length < 3 || GLUE_WORDS.has(w) || GLUE_WORDS.has(pluralStem(w))) continue;
    if (stemCandidates(w).some((c) => inputStems.has(c))) shared += 1;
    else fresh.push(w);
  }
  return { fresh, shared };
}

/** Bullets that read as work the owner did not write: nothing in common with their steps, and two or more new content words. */
export function addedWork(inputTexts: readonly string[], bullets: readonly string[]): string[] {
  const stems = new Set<string>();
  for (const t of inputTexts) for (const s of contentStems(t)) stems.add(s);
  return bullets.filter((b) => {
    const { fresh, shared } = newContent(b, stems);
    return shared === 0 && fresh.length >= 2;
  });
}
