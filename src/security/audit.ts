import type { Db } from './login-guard';

const PERSONAL_KEY = /(^|_)(name|email|phone|mobile|address|postcode|sortcode|accountnumber|password|token|secret)($|_)/i;
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export interface AuditEntry {
  tenantId: string | null;
  userId: string | null;
  impersonatorId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
}

function normaliseKey(key: string): string {
  // camelCase to snake_case, then drop separators inside compound words like sort_code
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/sort_code/g, 'sortcode').replace(/account_number/g, 'accountnumber');
}

/** The audit trail records what happened, never who the customers are. */
export function assertNoPersonalData(meta: unknown): void {
  if (Array.isArray(meta)) return meta.forEach(assertNoPersonalData);
  if (typeof meta === 'string') {
    if (EMAIL_VALUE.test(meta)) throw new Error('Audit data must not contain personal data (email address found)');
    return;
  }
  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta)) {
      if (PERSONAL_KEY.test(normaliseKey(key))) throw new Error(`Audit data must not contain personal data (key: ${key})`);
      assertNoPersonalData(value);
    }
  }
}

export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  const meta = e.meta ?? {};
  assertNoPersonalData(meta);
  await db.query(
    `insert into public.audit_log (tenant_id, user_id, impersonator_id, action, entity, entity_id, ip, user_agent, meta)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [e.tenantId, e.userId, e.impersonatorId ?? null, e.action, e.entity ?? null, e.entityId ?? null, e.ip ?? null, e.userAgent ?? null, JSON.stringify(meta)],
  );
}
