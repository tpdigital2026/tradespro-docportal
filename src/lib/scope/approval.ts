import { approvalHash, type ScopeFormValues } from './model';

/**
 * What the server keeps of an incoming scope on every save. The browser's own claims about approval are never
 * believed: the approval fields come only from what is already stored, and only while the incoming steps, wording
 * and note still hash to what was approved. Generated copy whose proof does not check out is dropped.
 */
export function sanitiseIncomingScope(incoming: ScopeFormValues, stored: ScopeFormValues | null, proofOk: (copy: NonNullable<ScopeFormValues['copy']>) => boolean): ScopeFormValues {
  const c = incoming.copy;
  if (!c) return incoming;
  if (!proofOk(c)) return { ...incoming, copy: null };
  const keep = stored?.copy?.approvedAt && stored.copy.approvalHash && stored.copy.approvalHash === approvalHash(incoming);
  return { ...incoming, copy: { ...c, approvedAt: keep ? stored!.copy!.approvedAt : null, approvalHash: keep ? stored!.copy!.approvalHash : null } };
}
