import { stripInvisible } from '../lib/scope/invisible';
import { findInventions, type Invention } from './invention';
import { PRODUCT_WORDS } from './vocab/products';
import { pluralStem, stemCandidates } from './vocab/stems';

/**
 * The invention check, adapted for survey findings. A finding may describe what is visible in the photos, so a
 * material or part the owner did not name is allowed ONLY when the draft also lists it in "uncertain" (the owner is
 * told to check it). Everything else that the quotation check refuses is refused here too (numbers, units, claims,
 * names, other scripts, hidden characters), plus causes, standards and costs the owner did not give.
 */
export interface FindingDraftText {
  title: string;
  observation: string;
  assessment: string;
  corrections: string[];
  uncertain: string[];
}

export type FindingProblem = Invention | { kind: 'cause' | 'standard' | 'cost' | 'unflagged'; word: string };

const PRODUCTS = new Set(PRODUCT_WORDS);
const WORD = /[\p{L}\p{M}]+/gu;
const norm = (t: string) => stripInvisible(t).normalize('NFKC').toLocaleLowerCase('en-GB');

/** Phrases that state a cause, a standard or a cost. The owner's own line unlocks the same phrase. */
const CAUSE = /\b(?:caused by|because|due to|as a result of|resulted? (?:from|in)|owing to|led to|leading to|the reason)\b/g;
const STANDARD = /\b(?:standards?|regulations?|regs|compliant|compliance|non-compliant|code of practice|building control|approved document|nhbc|british standard)\b/g;
const COST = /\b(?:costs?|costly|price[sd]?|pricing|cheap|expensive|pounds?|quote[sd]?|invoice[sd]?)\b/g;

const phrases = (re: RegExp, t: string) => new Set([...norm(t).matchAll(re)].map((m) => m[0]));

function productStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of norm(text).matchAll(WORD)) {
    const s = pluralStem(m[0]);
    if (PRODUCTS.has(s)) out.add(s);
    else for (const c of stemCandidates(m[0])) if (PRODUCTS.has(c)) out.add(c);
  }
  return out;
}

export function findingProblems(ownerLine: string, d: FindingDraftText): FindingProblem[] {
  const body = [d.title, d.observation, d.assessment];
  const all = [...body, ...d.corrections, ...d.uncertain];
  const out: FindingProblem[] = findInventions([ownerLine], all).filter((i) => i.kind !== 'product');
  for (const [kind, re] of [['cause', CAUSE], ['standard', STANDARD], ['cost', COST]] as const) {
    const owner = phrases(re, ownerLine);
    for (const t of all) for (const p of phrases(re, t)) if (!owner.has(p)) out.push({ kind, word: p });
  }
  const ownerProducts = productStems(ownerLine);
  const flagged = productStems(d.uncertain.join(' '));
  for (const t of body) for (const p of productStems(t)) if (!ownerProducts.has(p) && !flagged.has(p)) out.push({ kind: 'unflagged', word: p });
  return out;
}

/** The opinion is checked strictly: it may only use what is in the approved findings and the owner's line. */
export function opinionProblems(inputs: string[], opinion: string, uncertain: string[]): FindingProblem[] {
  const out: FindingProblem[] = findInventions(inputs, [opinion, ...uncertain]);
  const joined = inputs.join('\n');
  for (const [kind, re] of [['cause', CAUSE], ['standard', STANDARD], ['cost', COST]] as const) {
    const allowed = phrases(re, joined);
    for (const p of phrases(re, `${opinion}\n${uncertain.join('\n')}`)) if (!allowed.has(p)) out.push({ kind, word: p });
  }
  return out;
}
