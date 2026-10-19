import { approvalHash, approvalHashV1, cleanLine, cleanPara, type ScopeCopy, type ScopeFormValues } from './model';

/** The parts of a scope that only today's fingerprint covers (the first one did not). */
export const v2OnlyKey = (s: ScopeFormValues) =>
  JSON.stringify([cleanLine(s.coverTitle), cleanLine(s.coverSub), cleanPara(s.intro), s.specCards.map((c) => [cleanLine(c.value), cleanLine(c.label)]).filter((c) => c[0] !== '' || c[1] !== '')]);

/**
 * What the server keeps of an incoming scope on every save. The browser's own claims about approval are never
 * believed: the approval fields come only from what is already stored, and only while the incoming steps, wording
 * and note still hash to what was approved. Generated copy whose proof does not check out is dropped.
 *
 * An approval made under the first fingerprint is kept (still under that fingerprint, so it does not count as
 * approved) while the content it covered is unchanged and the cover, introduction and key figures are exactly as
 * stored. That keeps the chance to check and upgrade it, instead of an ordinary autosave wiping it out.
 */
export function sanitiseIncomingScope(incoming: ScopeFormValues, stored: ScopeFormValues | null, proofOk: (copy: ScopeCopy, stored: ScopeCopy | null) => boolean): ScopeFormValues {
  // Old-style notes that did not fit are only ever removed on purpose (an explicit empty string), never by a save that left the field out.
  const legacy = incoming.legacyOverflow === undefined && stored?.legacyOverflow ? { legacyOverflow: stored.legacyOverflow } : {};
  const c = incoming.copy;
  if (!c) return { ...incoming, ...legacy };
  if (!proofOk(c, stored?.copy ?? null)) return { ...incoming, ...legacy, copy: null };
  const sc = stored?.copy;
  const current = !!(sc?.approvedAt && sc.approvalHash && sc.approvalHash === approvalHash(incoming));
  const old = !current && !!(sc?.approvedAt && sc.approvalHash && sc.approvalHash === approvalHashV1(incoming) && stored && v2OnlyKey(stored) === v2OnlyKey(incoming));
  const keep = current || old;
  return { ...incoming, ...legacy, copy: { ...c, approvedAt: keep ? sc!.approvedAt : null, approvalHash: keep ? sc!.approvalHash : null } };
}
