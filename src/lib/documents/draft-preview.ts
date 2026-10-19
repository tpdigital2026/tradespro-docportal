/**
 * The inline preview of a draft (page 1 of the real document, on the Review step): what the screen is told, and
 * where each missing fact can be put right. Pure, so the browser and the tests can both use it.
 */

export type PreviewFixStep = 'customer' | 'job' | 'scope' | 'price' | 'plan';

export interface MissingFact {
  text: string;
  /** A step of the quote to open, or a page to go to (Settings). */
  fix: { kind: 'step'; step: PreviewFixStep; label: string } | { kind: 'link'; href: string; label: string } | null;
}

export type DraftPreview =
  | { state: 'ready'; documentId: string; key: string; pageCount: number; imageUrl: string; previewHref: string }
  | { state: 'missing'; documentId: string; missing: MissingFact[]; previewHref: string }
  | { state: 'busy'; message: string; diag: string }
  | { state: 'error'; message: string; diag: string };

const STEP_LABEL: Record<PreviewFixStep, string> = { customer: 'Open the Customer step', job: 'Open the Job step', scope: 'Open the Scope step', price: 'Open the Price step', plan: 'Open the Plan step' };
const step = (s: PreviewFixStep): MissingFact['fix'] => ({ kind: 'step', step: s, label: STEP_LABEL[s] });

/** Each line the document mapper reports, with the place to fix it. Unknown lines are shown as they are, with no link. */
export function missingFacts(lines: readonly string[]): MissingFact[] {
  return lines.map((text) => {
    const t = text.toLowerCase();
    let fix: MissingFact['fix'] = null;
    if (/wording is not set up|terms are not set up|bank account|settings/.test(t)) fix = { kind: 'link', href: '/settings', label: 'Open Settings' };
    else if (/scope wording|approve/.test(t)) fix = step('scope');
    else if (/payment plan|plan step|deposit/.test(t)) fix = step('plan');
    else if (/no price|amounts are too large/.test(t)) fix = step('price');
    else if (/customer has no name/.test(t)) fix = step('customer');
    else if (/property address|has no date/.test(t)) fix = step('job');
    else if (/the quote is not finished/.test(t)) fix = null;
    return { text, fix };
  });
}

/** The page image of a draft preview: private, never cached, tied to the content key it was drawn for. */
export const pageImageUrl = (documentId: string, key: string, page = 1) => `/api/documents/${encodeURIComponent(documentId)}/pages/${page}?key=${encodeURIComponent(key)}`;
