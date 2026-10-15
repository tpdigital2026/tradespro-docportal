import { connect } from '../../db/connect';
import { writeAudit } from '../../security/audit';
import type { Db } from '../../security/login-guard';
import type { StorageDeleter } from '../storage';

/** A single service connection (no app JWT). Always ended by the caller of withServiceConnection. */
export type ServiceDb = Db & { end(): Promise<void> };

export async function withServiceConnection<T>(fn: (db: ServiceDb) => Promise<T>, open: () => Promise<ServiceDb> = connect): Promise<T> {
  const db = await open();
  try {
    return await fn(db);
  } finally {
    await db.end().catch(() => undefined);
  }
}

export interface Actor {
  tenantId: string;
  userId: string;
}

/** Ids go in the audit trail as 32 hex characters with no hyphens, so the personal-data check cannot mistake them for a phone number. */
export function compactId(id: string): string {
  return id.replace(/-/g, '');
}

/**
 * Production always owns the transaction (begin and commit). Tests that must leave no trace pass
 * `nested: true` inside their own rolled-back transaction, and a savepoint stands in for begin/commit.
 */
export interface TxOptions {
  nested?: boolean;
}

function tx(db: Db, o: TxOptions) {
  const nested = o.nested === true;
  return {
    async start(): Promise<void> {
      await db.query(nested ? 'savepoint customer_tx' : 'begin');
      // A leaked JWT claim on this connection would make the final-version guard refuse, so clear it.
      await db.query('reset role');
      await db.query(`select set_config('request.jwt.claims', '', true)`);
      await db.query(`set local statement_timeout = '60s'`);
    },
    commit: () => db.query(nested ? 'release savepoint customer_tx' : 'commit'),
    rollback: () => db.query(nested ? 'rollback to savepoint customer_tx' : 'rollback'),
  };
}

export type EraseResult = 'erased' | 'not_found';

/**
 * Owner-requested erasure, the protocol in the README, in ONE transaction: claim the customer and
 * lock everything under it, list the stored files, delete them (any failure rolls everything back),
 * delete the customer, write the audit entry (ids only), commit.
 */
export async function eraseCustomerWith(db: Db, storage: StorageDeleter, actor: Actor, customerId: string, o: TxOptions = {}): Promise<EraseResult> {
  const t = tx(db, o);
  await t.start();
  try {
    const claimed = await db.query('select private.claim_customer($1, $2) as ok', [actor.tenantId, customerId]);
    if (claimed.rows[0]?.ok !== true) {
      await t.rollback();
      return 'not_found';
    }
    const paths = await db.query('select private.customer_storage_paths($1, $2) as path', [actor.tenantId, customerId]);
    const list = paths.rows.map((r) => String(r.path));
    await storage.deleteStorageObjects(list);
    // Page images and previews are not listed in any column; they live under the customer's folder.
    await storage.deleteStoragePrefix(`${actor.tenantId}/${customerId}/`);
    const erased = await db.query('select private.erase_customer($1, $2) as n', [actor.tenantId, customerId]);
    if (Number(erased.rows[0]?.n) !== 1) throw new Error('Erase did not remove exactly one customer');
    await writeAudit(db, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'customer.erase',
      entity: 'customer',
      entityId: compactId(customerId),
      meta: { files: list.length },
    });
    await t.commit();
    return 'erased';
  } catch (e) {
    await t.rollback().catch(() => undefined);
    throw e;
  }
}

/** "Keep for another N days": resets the clock through the SECURITY DEFINER path. Returns the new purge date or null. */
export async function extendRetentionWith(db: Db, actor: Actor, customerId: string, o: TxOptions = {}): Promise<string | null> {
  const t = tx(db, o);
  await t.start();
  try {
    const r = await db.query('select private.extend_customer_retention($1, $2) as purge_at', [actor.tenantId, customerId]);
    const at = r.rows[0]?.purge_at as Date | string | null | undefined;
    if (!at) {
      await t.rollback();
      return null;
    }
    await writeAudit(db, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'customer.keep',
      entity: 'customer',
      entityId: compactId(customerId),
    });
    await t.commit();
    return new Date(at).toISOString();
  } catch (e) {
    await t.rollback().catch(() => undefined);
    throw e;
  }
}

/**
 * The retention purge (README "Purge job protocol"), ONE transaction: claim the expired customers, list their files,
 * delete the files and each customer's folder (any failure rolls back), then delete the customers. Not scheduled yet:
 * a cron route or job calls this on a service connection.
 */
export async function purgeExpiredWith(db: Db, storage: StorageDeleter, o: TxOptions = {}): Promise<number> {
  const t = tx(db, o);
  await t.start();
  try {
    const claimed = await db.query('select id, tenant_id from private.claim_expired_customers(now())');
    const rows = claimed.rows as { id: string; tenant_id: string }[];
    const ids = rows.map((r) => r.id);
    const paths = ids.length ? await db.query('select private.expired_storage_paths($1::uuid[]) as path', [ids]) : { rows: [] };
    await storage.deleteStorageObjects(paths.rows.map((r) => String(r.path)));
    for (const r of rows) await storage.deleteStoragePrefix(`${r.tenant_id}/${r.id}/`);
    const done = await db.query('select private.purge_customers($1::uuid[], now()) as ids', [ids]);
    await t.commit();
    return ((done.rows[0]?.ids as string[] | null) ?? []).length;
  } catch (e) {
    await t.rollback().catch(() => undefined);
    throw e;
  }
}
