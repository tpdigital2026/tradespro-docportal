import { approvalHash, emptyScope, scopeKey, sectionsKey, type ScopeFormValues, type ScopeItem } from '../../src/lib/scope/model';

export const STEPS: ScopeItem[] = [
  { id: 'h1', kind: 'heading', text: 'Preparation' },
  { id: 's1', kind: 'step', text: 'strip off the existing roof covering' },
  { id: 's2', kind: 'step', text: 'Take all waste away.' },
];

/** A scope that is ready: steps written, copy made from exactly those steps, approved. */
export function approvedScope(over: Partial<ScopeFormValues> = {}): ScopeFormValues {
  const items = over.items ?? STEPS;
  const base: ScopeFormValues = {
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
      proof: 'test-proof',
      approvedAt: '2026-10-15T09:01:00.000Z',
      approvalHash: null,
    },
    ...over,
  };
  // Approved means the fingerprint matches the content, as the server writes it. Tests that want it unapproved pass copy with approvedAt null.
  if (base.copy && base.copy.approvedAt && base.copy.approvalHash === null) base.copy = { ...base.copy, approvalHash: approvalHash(base) };
  return base;
}

import { signGenerated } from '../../src/lib/scope/proof';

/** Wording as the server hands it out after Generate copy: a real proof, not yet approved. */
export function generatedScope(tenantId: string, over: Partial<ScopeFormValues> = {}, generatedAt: string = new Date().toISOString()): ScopeFormValues {
  const s = approvedScope(over);
  const made = { ...s.copy!, generatedAt, genKey: sectionsKey(s.copy!.sections) };
  return { ...s, copy: { ...made, proof: signGenerated(tenantId, made), approvedAt: null, approvalHash: null } };
}

/** The same content with the approval fingerprint worked out for it (as the server writes it). */
export function reapprove(s: ScopeFormValues): ScopeFormValues {
  return { ...s, copy: { ...s.copy!, approvedAt: s.copy!.approvedAt ?? '2026-10-15T09:01:00.000Z', approvalHash: approvalHash(s) } };
}
