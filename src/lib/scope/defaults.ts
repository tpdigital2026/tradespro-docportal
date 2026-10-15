import type { ScopeExamples } from './examples';
import type { ScopeFormValues } from './model';

export interface TypeLike {
  id: string;
  label: string;
  scopeExamples: ScopeExamples | null;
}

export const autoTitle = (label: string | undefined): string => (label && label.trim() !== '' ? `${label.trim()} quotation` : 'Quotation');

/**
 * Suggested cover title and introduction for the job type. They replace the previous suggestion only while the
 * owner has not changed it, so typed wording is never overwritten.
 */
export function applyJobTypeDefaults(scope: ScopeFormValues, types: readonly TypeLike[], oldId: string, newId: string): ScopeFormValues {
  const was = types.find((t) => t.id === oldId);
  const now = types.find((t) => t.id === newId);
  const next = { ...scope };
  if (scope.coverTitle.trim() === '' || scope.coverTitle === autoTitle(was?.label)) next.coverTitle = autoTitle(now?.label);
  const wasIntro = was?.scopeExamples?.intro ?? '';
  if (scope.intro.trim() === '' || (wasIntro !== '' && scope.intro === wasIntro)) next.intro = now?.scopeExamples?.intro ?? '';
  return next;
}

/** A scope nobody has touched yet. */
export function isPristine(scope: ScopeFormValues): boolean {
  return scope.coverTitle === '' && scope.coverSub === '' && scope.intro === '' && scope.note === '' && scope.specCards.length === 0 && scope.items.length === 0 && scope.copy === null;
}
