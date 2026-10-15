import { approvalHash, type ScopeCopy, type ScopeFormValues } from './model';

/**
 * What the server keeps of an incoming scope on every save. The browser's own claims about approval are never
 * believed: the approval fields come only from what is already stored, and only while the incoming steps, wording
 * and note still hash to what was approved. Generated copy whose proof does not check out is dropped.
 */
export function sanitiseIncomingScope(incoming: ScopeFormValues, stored: ScopeFormValues | null, proofOk: (copy: ScopeCopy, stored: ScopeCopy | null) => boolean): ScopeFormValues {
  // Old-style notes that did not fit are only ever removed on purpose (an explicit empty string), never by a save that left the field out.
  const legacy = incoming.legacyOverflow === undefined && stored?.legacyOverflow ? { legacyOverflow: stored.legacyOverflow } : {};
  const c = incoming.copy;
  if (!c) return { ...incoming, ...legacy };
  if (!proofOk(c, stored?.copy ?? null)) return { ...incoming, ...legacy, copy: null };
  const keep = stored?.copy?.approvedAt && stored.copy.approvalHash && stored.copy.approvalHash === approvalHash(incoming);
  return { ...incoming, ...legacy, copy: { ...c, approvedAt: keep ? stored!.copy!.approvedAt : null, approvalHash: keep ? stored!.copy!.approvalHash : null } };
}
