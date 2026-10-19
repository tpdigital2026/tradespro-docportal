import type { Db } from '../security/login-guard';
import { checkSignatureUpload, type Reencoder } from '../lib/signature-image';
import type { DocumentStorage } from '../lib/storage';
import { saveSignatureWith } from '../lib/data/signature-store';
import { compactId } from '../lib/data/customer-admin';
import { writeAudit } from '../security/audit';

export type SignatureSeedResult = 'stored' | 'kept' | 'no_business' | 'no_brand_kit';

/**
 * Stores the owner's signature as the business's signature brand asset and switches printing on, exactly as an upload
 * in Settings would: the same checks (checkSignatureUpload), the same re-encode in the render browser (metadata
 * dropped, fixed output size), the same storage path and row (saveSignatureWith), with an audit row naming the
 * business's owner. Idempotent and never overwrites the owner's choice: if the business already has a signature
 * picture, nothing changes (not the picture, not the printing switch).
 */
export async function seedSignature(db: Db, storage: DocumentStorage, tenantId: string, bytes: Buffer, reencode: Reencoder): Promise<SignatureSeedResult> {
  const t = await db.query(`select id from public.tenants where id = $1`, [tenantId]);
  if (!t.rows[0]) return 'no_business';
  const has = await db.query(`select 1 from public.brand_assets where tenant_id = $1 and kind = 'signature' limit 1`, [tenantId]);
  if (has.rows[0]) return 'kept';
  const kit = await db.query(`select 1 from public.brand_kits where tenant_id = $1`, [tenantId]);
  if (!kit.rows[0]) return 'no_brand_kit';
  const check = checkSignatureUpload(bytes);
  if (!check.ok) throw new Error(check.message);
  const image = await reencode(bytes, check.image);
  const owner = await db.query(`select id from public.profiles where tenant_id = $1 and role = 'owner' order by created_at limit 1`, [tenantId]);
  const userId = owner.rows[0] ? String(owner.rows[0].id) : null;
  await saveSignatureWith(db, storage, { tenantId, userId: userId as string }, image, { nested: true });
  await db.query(
    `update public.tenant_defaults set signature_consent = true, signature_consent_at = now(), signature_consent_by = $2 where tenant_id = $1`,
    [tenantId, userId],
  );
  await writeAudit(db, { tenantId, userId, action: 'signature.consent', entity: 'tenant', entityId: compactId(tenantId), meta: { on: true, seeded: true } });
  return 'stored';
}
