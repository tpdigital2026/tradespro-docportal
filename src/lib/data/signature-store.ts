/**
 * Storing a business's signature picture: the exact path and rows an upload in Settings produces. Kept apart from the
 * settings data layer (which needs a signed-in request) so the FJC seed script can use the very same code.
 */
import { randomUUID } from 'node:crypto';
import { writeAudit } from '../../security/audit';
import type { Db } from '../../security/login-guard';
import type { Reencoded } from '../signature-image';
import type { DocumentStorage } from '../storage';
import { compactId, type Actor, type TxOptions } from './customer-admin';
import { SettingsError } from './settings-error';

export const signaturePath = (tenantId: string, id: string) => `${tenantId}/brand/signature-${id}.png`;

/**
 * Stores a re-encoded signature. The file goes up first, under a new name that nothing else uses (never overwriting),
 * then one short transaction records it and drops the older signature rows. If that transaction is refused, the new
 * file is deleted again; if the commit's outcome is unknown nothing is deleted (the orphan sweep removes it later if it
 * turns out to be unreferenced). Older files go after the commit, best effort, for the same reason. A new picture never
 * switches printing on by itself.
 */
export async function saveSignatureWith(db: Db, storage: DocumentStorage, actor: Actor, image: Reencoded, o: TxOptions = {}): Promise<{ id: string }> {
  const nested = o.nested === true;
  const kit = await db.query(`select id from public.brand_kits where tenant_id = $1`, [actor.tenantId]);
  if (!kit.rows[0]) throw new SettingsError('not_configured', 'Your brand kit is not set up yet, so a signature cannot be stored. Contact TradesPro Digital.');
  const id = randomUUID();
  const path = signaturePath(actor.tenantId, id);
  await storage.put(path, image.png, 'image/png', { overwrite: false });
  let committing = false;
  let old: string[] = [];
  try {
    await db.query(nested ? 'savepoint signature_tx' : 'begin');
    await db.query('reset role');
    await db.query(`select set_config('request.jwt.claims', '', true)`);
    await db.query(`set local statement_timeout = '15s'`);
    await db.query(`set local lock_timeout = '5s'`);
    const prev = await db.query(`select id, storage_path from public.brand_assets where tenant_id = $1 and kind = 'signature' order by id for update`, [actor.tenantId]);
    old = prev.rows.map((r) => String(r.storage_path));
    await db.query(
      `insert into public.brand_assets (id, tenant_id, brand_kit_id, kind, storage_path, width, height, alt) values ($1, $2, $3, 'signature', $4, $5, $6, '')`,
      [id, actor.tenantId, kit.rows[0].id, path, image.width, image.height],
    );
    if (old.length) await db.query(`delete from public.brand_assets where tenant_id = $1 and kind = 'signature' and id <> $2`, [actor.tenantId, id]);
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'signature.upload', entity: 'brand_asset', entityId: compactId(id), meta: { w: image.width, h: image.height } });
    committing = true;
    await db.query(nested ? 'release savepoint signature_tx' : 'commit');
  } catch (e) {
    await db.query(nested ? 'rollback to savepoint signature_tx' : 'rollback').catch(() => undefined);
    if (!committing) await storage.deleteStorageObjects([path]).catch(() => undefined);
    throw e;
  }
  await storage.deleteStorageObjects(old.filter((p) => p !== path)).catch(() => undefined);
  return { id };
}

