import type { Db } from './login-guard';

const MAX_JSON_LENGTH = 8192;
const MAX_DEPTH = 8;

// Any of these inside a key (or the key with separators removed) marks it as personal. 'name' is
// matched as a whole segment, or as the end of the collapsed key (customername). The list fails
// closed: file_name, brand_name and token_hash style keys are rejected too. Use ids instead.
const PERSONAL_TERMS = [
  'firstname', 'lastname', 'surname', 'fullname', 'email', 'emails', 'mail', 'phone', 'mobile', 'tel', 'telephone',
  'address', 'addr', 'postcode', 'zip', 'recipient', 'sortcode', 'accountnumber', 'accountno', 'iban', 'password', 'token', 'secret',
];
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// 0, +44, 0044 or +44 (0) prefixes; brackets and dots are stripped before matching.
const UK_PHONE = /(?:(?:\+|\b00)44[\s-]?0?|\b0)(?:\d[\s-]?){9,10}\b/;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

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

function fail(what: string): never {
  throw new Error(`Audit data must not contain personal data (${what})`);
}

function checkKey(key: string): void {
  const nfkc = key.normalize('NFKC');
  if (/[^\x00-\x7f]/.test(nfkc)) fail('non-ASCII key');
  if (EMAIL_PATTERN.test(nfkc)) fail('email-like key');
  const spaced = nfkc.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
  const segments = spaced.split(/[^a-z0-9]+/).filter(Boolean);
  const collapsed = segments.join('');
  if (segments.includes('name') || collapsed.endsWith('name')) fail(`key: ${key}`);
  if (PERSONAL_TERMS.some((t) => collapsed.includes(t))) fail(`key: ${key}`);
}

/** Checks one string value (also used for the top-level action, entity and entityId). */
export function assertNoPersonalValue(raw: string): void {
  const value = raw.normalize('NFKC'); // full-width digits and @ become plain ASCII
  if (EMAIL_PATTERN.test(value)) fail('email address found');
  if (UK_PHONE.test(value.replace(/[().]/g, '').replace(/\s+/g, ' '))) fail('phone number found');
  if (UK_POSTCODE.test(value)) fail('postcode found');
}

function walk(value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error('Audit data is nested too deeply');
  if (Array.isArray(value)) return value.forEach((v) => walk(v, depth + 1));
  if (typeof value === 'string') return assertNoPersonalValue(value);
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      checkKey(key);
      walk(v, depth + 1);
    }
  }
}

/**
 * The audit trail records what happened, never who the customers are.
 * Returns the exact JSON string that was checked; store that string, never a second serialisation.
 */
export function assertNoPersonalData(meta: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(meta);
  } catch {
    throw new Error('Audit data could not be serialised');
  }
  if (json === undefined) throw new Error('Audit data could not be serialised');
  if (json.length > MAX_JSON_LENGTH) throw new Error(`Audit data is too large (over ${MAX_JSON_LENGTH} characters)`);
  // Check what will actually be stored: the parsed JSON, so toJSON tricks cannot hide anything.
  walk(JSON.parse(json), 0);
  return json;
}

export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  const metaJson = assertNoPersonalData(e.meta ?? {});
  for (const v of [e.action, e.entity, e.entityId]) if (typeof v === 'string') assertNoPersonalValue(v);
  await db.query(
    `insert into public.audit_log (tenant_id, user_id, impersonator_id, action, entity, entity_id, ip, user_agent, meta)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [e.tenantId, e.userId, e.impersonatorId ?? null, e.action, e.entity ?? null, e.entityId ?? null, e.ip ?? null, e.userAgent ?? null, metaJson],
  );
}
