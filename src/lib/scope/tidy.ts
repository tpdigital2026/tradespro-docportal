import { cleanLine, DEFAULT_SECTION_HEADING, groupItems, type CopySection, type ScopeItem } from './model';

/**
 * The basic tidy: capital letters, full stops, single spaces, repeated steps merged. It never changes a word,
 * so it can never add work, materials, figures or claims. It is the engine whenever the AI is off or not trusted.
 */

const ENDS = /[.!?]$/;

function capitalise(s: string): string {
  if (s === '') return s;
  const first = s.charAt(0);
  const up = first.toLocaleUpperCase('en-GB');
  return up === first ? s : up + s.slice(1);
}

export function tidyStep(raw: string): string {
  let s = cleanLine(raw);
  if (s === '') return '';
  s = capitalise(s);
  s = s.replace(/[,;:\s]+$/, '');
  if (s === '') return '';
  if (!ENDS.test(s)) s += '.';
  return s;
}

export function tidyHeading(raw: string): string {
  const s = cleanLine(raw).replace(/[.:;,\s]+$/, '');
  return capitalise(s);
}

/** Two steps are the same step when they differ only by case, spacing or punctuation. */
export function sameStepKey(s: string): string {
  return s.toLocaleLowerCase('en-GB').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 57)}...` : s}"`;

export interface Tidied {
  sections: CopySection[];
  corrections: string[];
  uncertain: string[];
}

export function tidyItems(items: readonly ScopeItem[]): Tidied {
  const corrections: string[] = [];
  const sections: CopySection[] = [];
  let capitals = 0;
  let stops = 0;
  for (const g of groupItems(items)) {
    const heading = g.heading === null ? DEFAULT_SECTION_HEADING : tidyHeading(g.heading);
    const seen = new Set<string>();
    const steps: string[] = [];
    for (const raw of g.steps) {
      const t = tidyStep(raw);
      if (t === '') continue;
      const key = sameStepKey(t);
      if (seen.has(key)) {
        corrections.push(`Merged a repeated step: ${quote(t)}`);
        continue;
      }
      seen.add(key);
      if (t.charAt(0) !== raw.trim().charAt(0)) capitals += 1;
      if (!ENDS.test(raw.trim())) stops += 1;
      steps.push(t);
    }
    if (steps.length > 0) sections.push({ heading, steps });
  }
  if (capitals > 0) corrections.unshift(capitals === 1 ? 'Started a step with a capital letter.' : 'Started steps with a capital letter.');
  if (stops > 0) corrections.unshift(stops === 1 ? 'Ended a step with a full stop.' : 'Ended steps with a full stop.');
  return { sections, corrections: corrections.slice(0, 60), uncertain: [] };
}
