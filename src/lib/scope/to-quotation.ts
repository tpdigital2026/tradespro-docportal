import type { QuotationInput } from '../../templates/quotation';
import { cleanCopySections, cleanLine, copyErrors, isApproved, NOTE_LABEL, type ScopeFormValues } from './model';

export type QuotationScope = Pick<QuotationInput, 'coverTitle' | 'coverSub' | 'introText' | 'specCards' | 'callout' | 'scope'>;

/**
 * The scope part of a quotation, from the form. Pure. Uses the approved copy (never the raw steps), so a quote
 * whose wording is not approved cannot be built. The rest of QuotationInput (customer, money, terms) is not this
 * function's business.
 */
export function toQuotationScope(scope: ScopeFormValues): { ok: true; value: QuotationScope } | { ok: false; reason: string } {
  if (!scope.copy || !isApproved(scope)) return { ok: false, reason: 'The wording has not been approved' };
  const bad = copyErrors(scope.copy);
  const first = Object.values(bad)[0];
  if (first) return { ok: false, reason: first };
  const coverTitle = cleanLine(scope.coverTitle);
  if (coverTitle === '') return { ok: false, reason: 'The quote has no title' };

  const specCards: QuotationScope['specCards'] = [];
  for (const c of scope.specCards) {
    const big = cleanLine(c.value);
    const label = cleanLine(c.label);
    if (big === '' && label === '') continue;
    if (big === '' || label === '') return { ok: false, reason: 'A key figure is half filled in' };
    specCards.push({ big, label });
  }

  const note = scope.note.replace(/\r\n?/g, '\n').trim();
  return {
    ok: true,
    value: {
      coverTitle,
      coverSub: cleanLine(scope.coverSub),
      introText: scope.intro.replace(/\r\n?/g, '\n').trim(),
      specCards,
      callout: note === '' ? null : { label: NOTE_LABEL, text: note },
      scope: cleanCopySections(scope.copy.sections).map((s) => ({ heading: s.heading, bullets: s.steps })),
    },
  };
}
