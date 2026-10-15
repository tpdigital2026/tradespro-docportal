import { emptyScope, scopeKey, type ScopeFormValues, type ScopeItem } from '../../src/lib/scope/model';

export const STEPS: ScopeItem[] = [
  { id: 'h1', kind: 'heading', text: 'Preparation' },
  { id: 's1', kind: 'step', text: 'strip off the existing roof covering' },
  { id: 's2', kind: 'step', text: 'Take all waste away.' },
];

/** A scope that is ready: steps written, copy made from exactly those steps, approved. */
export function approvedScope(over: Partial<ScopeFormValues> = {}): ScopeFormValues {
  const items = over.items ?? STEPS;
  return {
    ...emptyScope(),
    coverTitle: 'Flat roof quotation',
    items,
    copy: {
      sections: [{ heading: 'Preparation', steps: ['Strip off the existing roof covering.', 'Take all waste away.'] }],
      corrections: [],
      uncertain: [],
      engine: 'fallback',
      generatedAt: '2026-10-15T09:00:00.000Z',
      sourceKey: scopeKey(items),
      approvedAt: '2026-10-15T09:01:00.000Z',
    },
    ...over,
  };
}
