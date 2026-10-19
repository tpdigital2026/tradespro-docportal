/**
 * Loads a guarantee certificate's facts on a service connection. As everywhere on that connection, EVERY query is
 * filtered by the tenant from the session. The owner's stored signature is read here too (only when the owner has
 * switched printing on), so a preview and its final copy never differ on whether it is there.
 */
import type { Db } from '../../security/login-guard';
import { brandWith, businessWith, signatureWith, type DocumentHead, type FileReader, type Loaded } from '../documents/facts-sql';
import type { GuaranteeFacts } from './map';
import { parseGuaranteeInput } from './model';

export async function loadGuaranteeWith(db: Db, tenantId: string, head: DocumentHead, opts: { decryptBank?: boolean; files?: FileReader } = {}): Promise<Loaded> {
  const problems: string[] = [];
  const newest = head.versions[0] ?? null;
  const values = newest ? parseGuaranteeInput(newest.input) : null;
  const cr = await db.query(`select name from public.customers where id = $1 and tenant_id = $2`, [head.customerId, tenantId]);
  if (!cr.rows[0]) problems.push('The job or customer for this document could not be found.');
  const biz = await businessWith(db, tenantId);
  problems.push(...biz.problems);
  const brand = await brandWith(db, tenantId, biz.slug);
  problems.push(...brand.problems);
  if (opts.decryptBank === true && brand.brand) {
    const files: FileReader = opts.files ?? (async (p) => (await import('../storage')).getStorage().get(p));
    const sig = await signatureWith(db, tenantId, files);
    if (sig.problem) problems.push(sig.problem);
    brand.brand = { ...brand.brand, assets: { ...brand.brand.assets, signature: sig.uri } };
  }
  const guarantee: GuaranteeFacts = { number: head.number, jobReference: head.quoteNumber, customerName: String(cr.rows[0]?.name ?? ''), values };
  return { head, facts: null, problems, business: biz.business, brand: brand.brand, bankLabel: null, bankAccountId: null, guarantee };
}
