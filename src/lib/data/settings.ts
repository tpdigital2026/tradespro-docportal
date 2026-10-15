/**
 * The owner's Settings: business details (read only), bank accounts, signature, customer data retention and the
 * session policy.
 *
 * Reads go through the signed-in person's session (row level security; the app role can see only the safe bank
 * columns: name, bank, last four digits). Every write is a server write on a service connection, in one transaction,
 * with the tenant taken from the session, after the caller has checked the owner role and a fresh emailed code. Bank
 * numbers are validated, normalised and encrypted (security/bank-crypto, AES-256-GCM, bound to the tenant and field),
 * never logged and never read back: after saving, only the last four digits exist outside the encrypted columns.
 * Audit entries hold ids and settings values only. Demo mode keeps everything in memory.
 */
import { randomUUID } from 'node:crypto';
import { encryptBankDetails, last4 as lastFour, parseKey } from '../../security/bank-crypto';
import { writeAudit } from '../../security/audit';
import type { Db } from '../../security/login-guard';
import { demoBankAccounts, demoBusiness } from '../demo-data';
import { demoSlot, isDemo } from '../demo';
import { DEFAULT_RETENTION_DAYS, safeRetentionDays } from '../retention';
import { DEFAULT_LIMITS, limitsFrom, type SessionLimits } from '../session-policy-limits';
import { signatureDataUri, type Reencoded } from '../signature-image';
import type { DocumentStorage, StorageDeleter } from '../storage';
import { MAX_ACTIVE_ACCOUNTS, type BankInput } from '../validation/settings';
import { compactId, type Actor } from './customer-admin';
import { ownerClient, type DataClient } from './customers';
import { requireSession } from '../session';

export interface BusinessDetails {
  name: string;
  companyNumber: string;
  vatNumber: string;
  phone: string;
  email: string;
  website: string;
  addressLines: string[];
  postcode: string;
  ownerName: string;
  ownerTitle: string;
}

export interface BankAccountView {
  id: string;
  accountName: string;
  bankName: string;
  last4: string;
  isDefault: boolean;
  archived: boolean;
}

export interface SettingsView {
  business: BusinessDetails;
  bankAccounts: BankAccountView[];
  retentionDays: number;
  session: SessionLimits;
  signature: { consent: boolean; hasImage: boolean };
}

export class SettingsError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'limit' | 'not_configured' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** How an account reads everywhere: name, bank (when given), last four digits. Never more. */
export function bankLabel(a: { accountName: string; bankName: string; last4: string }): string {
  return [a.accountName, a.bankName, `ending ${a.last4}`].filter((x) => x.trim() !== '').join(', ');
}

const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');

// ---------------------------------------------------------------- reads (the signed-in person's session)

export async function getSettingsWith(client: DataClient): Promise<SettingsView> {
  const [t, banks, defaults, sig] = await Promise.all([
    client.from('tenants').select('name, company_number, vat_registered, vat_number, phone, email, website, address_lines, postcode, owner_name, owner_title').maybeSingle(),
    client.from('bank_accounts').select('id, account_name, bank_name, last4, is_default, archived_at, created_at').order('created_at', { ascending: true }).limit(50),
    client.from('tenant_defaults').select('retention_days, idle_logout_minutes, max_session_days, signature_consent').maybeSingle(),
    client.from('brand_assets').select('id').eq('kind', 'signature').limit(1),
  ]);
  if (t.error || !t.data || banks.error || defaults.error || sig.error) throw new SettingsError('failed', 'Could not load your settings');
  const r = t.data as Record<string, unknown>;
  const d = (defaults.data ?? {}) as Record<string, unknown>;
  return {
    business: {
      name: str(r.name),
      companyNumber: str(r.company_number),
      vatNumber: r.vat_registered ? str(r.vat_number) : '',
      phone: str(r.phone),
      email: str(r.email),
      website: str(r.website),
      addressLines: Array.isArray(r.address_lines) ? (r.address_lines as unknown[]).map(str).filter(Boolean) : [],
      postcode: str(r.postcode),
      ownerName: str(r.owner_name),
      ownerTitle: str(r.owner_title),
    },
    bankAccounts: ((banks.data ?? []) as Record<string, unknown>[]).map((b) => ({
      id: String(b.id),
      accountName: str(b.account_name),
      bankName: str(b.bank_name),
      last4: str(b.last4),
      isDefault: b.is_default === true && !b.archived_at,
      archived: Boolean(b.archived_at),
    })),
    retentionDays: safeRetentionDays(d.retention_days),
    session: limitsFrom(d),
    signature: { consent: d.signature_consent === true, hasImage: ((sig.data ?? []) as unknown[]).length > 0 },
  };
}

// ---------------------------------------------------------------- writes (service connection, one transaction each)

/** Production owns the transaction; tests pass nested: true inside their own rolled-back one (a savepoint stands in). */
export interface TxOptions {
  nested?: boolean;
}

async function inTx<T>(db: Db, fn: () => Promise<T>, o: TxOptions = {}): Promise<T> {
  const nested = o.nested === true;
  await db.query(nested ? 'savepoint settings_tx' : 'begin');
  try {
    // A leaked app JWT on this connection would make the server-only triggers refuse; this is a server write.
    await db.query('reset role');
    await db.query(`select set_config('request.jwt.claims', '', true)`);
    await db.query(`set local statement_timeout = '15s'`);
    await db.query(`set local lock_timeout = '5s'`);
    const out = await fn();
    await db.query(nested ? 'release savepoint settings_tx' : 'commit');
    return out;
  } catch (e) {
    await db.query(nested ? 'rollback to savepoint settings_tx' : 'rollback').catch(() => undefined);
    throw e;
  }
}

/** The encryption key, or a clear refusal. Never a quiet fallback. */
export function bankKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.BANK_ENCRYPTION_KEY;
  if (!raw) throw new SettingsError('not_configured', 'Bank details cannot be saved on this server yet. Contact TradesPro Digital.');
  try {
    return parseKey(raw);
  } catch {
    throw new SettingsError('not_configured', 'Bank details cannot be saved on this server yet. Contact TradesPro Digital.');
  }
}

/** Adds an account (already validated and normalised). The first active account becomes the default. Returns the safe view. */
export async function addBankAccountWith(db: Db, actor: Actor, input: BankInput, key: Buffer, o: TxOptions = {}): Promise<BankAccountView> {
  // Encrypt before the transaction: nothing secret is ever in a statement's text, only in its parameters.
  const enc = encryptBankDetails({ sortCode: input.sortCode, accountNumber: input.accountNumber }, key, actor.tenantId);
  return inTx(db, async () => {
    // One add at a time per business: row locks cannot stop two inserts both counting nine and both adding one,
    // so a transaction-scoped advisory lock on the tenant serialises adds before the count.
    await db.query(`select pg_advisory_xact_lock(hashtextextended('bank-accounts:' || $1::text, 0))`, [actor.tenantId]);
    const active = await db.query(`select id, is_default from public.bank_accounts where tenant_id = $1 and archived_at is null order by id for update`, [actor.tenantId]);
    if (active.rows.length >= MAX_ACTIVE_ACCOUNTS) throw new SettingsError('limit', `You can keep up to ${MAX_ACTIVE_ACCOUNTS} accounts. Archive one you no longer use first.`);
    const isDefault = !active.rows.some((r) => r.is_default === true);
    const ins = await db.query(
      `insert into public.bank_accounts (tenant_id, account_name, bank_name, sort_code_enc, account_number_enc, last4, is_default)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [actor.tenantId, input.accountName, input.bankName, enc.sort_code_enc, enc.account_number_enc, enc.last4, isDefault],
    );
    const id = String(ins.rows[0].id);
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'bank.add', entity: 'bank_account', entityId: compactId(id), meta: { first: isDefault } });
    return { id, accountName: input.accountName, bankName: input.bankName, last4: enc.last4, isDefault, archived: false };
  }, o);
}

export async function renameBankAccountWith(db: Db, actor: Actor, id: string, names: { accountName: string; bankName: string }, o: TxOptions = {}): Promise<void> {
  await inTx(db, async () => {
    const r = await db.query(`update public.bank_accounts set account_name = $1, bank_name = $2 where id = $3 and tenant_id = $4 and archived_at is null returning id`, [names.accountName, names.bankName, id, actor.tenantId]);
    if (!r.rows[0]) throw new SettingsError('not_found', 'That account could not be found.');
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'bank.rename', entity: 'bank_account', entityId: compactId(id) });
  }, o);
}

export async function setDefaultBankAccountWith(db: Db, actor: Actor, id: string, o: TxOptions = {}): Promise<void> {
  await inTx(db, async () => {
    // Every active account of the business is locked, so two changes of default queue up.
    const rows = await db.query(`select id from public.bank_accounts where tenant_id = $1 and archived_at is null order by id for update`, [actor.tenantId]);
    if (!rows.rows.some((r) => String(r.id) === id)) throw new SettingsError('not_found', 'That account could not be found.');
    // Clear first: the database allows one default per business (bank_accounts_one_default).
    await db.query(`update public.bank_accounts set is_default = false where tenant_id = $1 and is_default and id <> $2`, [actor.tenantId, id]);
    await db.query(`update public.bank_accounts set is_default = true where id = $1 and tenant_id = $2`, [id, actor.tenantId]);
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'bank.default', entity: 'bank_account', entityId: compactId(id) });
  }, o);
}

/**
 * Archives an account (it is never deleted: finalised documents may name it). When it was the default, the oldest
 * other active account becomes the default, so invoices always have one to use; its id is returned.
 */
export async function archiveBankAccountWith(db: Db, actor: Actor, id: string, o: TxOptions = {}): Promise<{ newDefaultId: string | null }> {
  return inTx(db, async () => {
    const rows = await db.query(`select id, is_default from public.bank_accounts where tenant_id = $1 and archived_at is null order by created_at, id for update`, [actor.tenantId]);
    const mine = rows.rows.find((r) => String(r.id) === id);
    if (!mine) throw new SettingsError('not_found', 'That account could not be found.');
    await db.query(`update public.bank_accounts set archived_at = now(), is_default = false where id = $1 and tenant_id = $2`, [id, actor.tenantId]);
    let newDefaultId: string | null = null;
    if (mine.is_default === true) {
      const next = rows.rows.find((r) => String(r.id) !== id);
      if (next) {
        newDefaultId = String(next.id);
        await db.query(`update public.bank_accounts set is_default = true where id = $1 and tenant_id = $2`, [newDefaultId, actor.tenantId]);
      }
    }
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'bank.archive', entity: 'bank_account', entityId: compactId(id), meta: newDefaultId ? { promoted: compactId(newDefaultId) } : {} });
    return { newDefaultId };
  }, o);
}

async function upsertDefaults(db: Db, tenantId: string, set: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(set);
  if (!cols.every((c) => /^[a-z_]+$/.test(c))) throw new Error('Bad column');
  const vals = cols.map((c) => set[c]);
  await db.query(
    `insert into public.tenant_defaults (tenant_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
     on conflict (tenant_id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    [tenantId, ...vals],
  );
}

/**
 * Saves retention_days. Raising it also gives every customer already on file the longer period
 * (greatest(purge_at, last activity + days), private.extend_purge_for_retention, same transaction). Lowering it never
 * shortens a date already set: those customers keep their current deletion date until something happens on their
 * record. Returns the old value and how many customers were moved later.
 */
export async function setRetentionWith(db: Db, actor: Actor, days: number, o: TxOptions = {}): Promise<{ previous: number; extended: number }> {
  return inTx(db, async () => {
    const cur = await db.query(`select retention_days from public.tenant_defaults where tenant_id = $1 for update`, [actor.tenantId]);
    const previous = safeRetentionDays(cur.rows[0]?.retention_days);
    await upsertDefaults(db, actor.tenantId, { retention_days: days });
    let extended = 0;
    if (days > previous) {
      const r = await db.query('select private.extend_purge_for_retention($1, $2) as n', [actor.tenantId, days]);
      extended = Number(r.rows[0]?.n ?? 0);
    }
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'settings.retention', entity: 'tenant', entityId: compactId(actor.tenantId), meta: { days, was: previous, extended } });
    return { previous, extended };
  }, o);
}

export async function setSessionPolicyWith(db: Db, actor: Actor, limits: SessionLimits, o: TxOptions = {}): Promise<void> {
  await inTx(db, async () => {
    await upsertDefaults(db, actor.tenantId, { idle_logout_minutes: limits.idleMinutes, max_session_days: limits.maxDays });
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'settings.session', entity: 'tenant', entityId: compactId(actor.tenantId), meta: { idle: limits.idleMinutes, days: limits.maxDays } });
  }, o);
}

/** Turning printing on needs a stored image. Turning it off always works. */
export async function setSignatureConsentWith(db: Db, actor: Actor, on: boolean, o: TxOptions = {}): Promise<void> {
  await inTx(db, async () => {
    if (on) {
      const img = await db.query(`select 1 from public.brand_assets where tenant_id = $1 and kind = 'signature' limit 1`, [actor.tenantId]);
      if (!img.rows[0]) throw new SettingsError('invalid', 'Add a picture of your signature first.');
    }
    await upsertDefaults(db, actor.tenantId, on ? { signature_consent: true, signature_consent_at: new Date(), signature_consent_by: actor.userId } : { signature_consent: false, signature_consent_at: null, signature_consent_by: null });
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'signature.consent', entity: 'tenant', entityId: compactId(actor.tenantId), meta: { on } });
  }, o);
}

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

/** Removes the stored signature and switches printing off, together. */
export async function removeSignatureWith(db: Db, storage: StorageDeleter, actor: Actor, o: TxOptions = {}): Promise<void> {
  const paths = await inTx(db, async () => {
    const rows = await db.query(`delete from public.brand_assets where tenant_id = $1 and kind = 'signature' returning storage_path`, [actor.tenantId]);
    await upsertDefaults(db, actor.tenantId, { signature_consent: false, signature_consent_at: null, signature_consent_by: null });
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'signature.remove', entity: 'tenant', entityId: compactId(actor.tenantId) });
    return rows.rows.map((r) => String(r.storage_path));
  }, o);
  await storage.deleteStorageObjects(paths).catch(() => undefined);
}

/** The stored signature file's path for this business, or null (any person of the business may see it). */
export async function signaturePathWith(db: Db, tenantId: string): Promise<string | null> {
  const r = await db.query(`select storage_path from public.brand_assets where tenant_id = $1 and kind = 'signature' order by created_at desc limit 1`, [tenantId]);
  return r.rows[0] ? String(r.rows[0].storage_path) : null;
}

// ---------------------------------------------------------------- demo mode (in memory, dummy data)

interface DemoSettings {
  accounts: BankAccountView[];
  retentionDays: number;
  session: SessionLimits;
  consent: boolean;
  signature: Reencoded | null;
}

const demoBox = demoSlot<DemoSettings>('settings', () => ({
  accounts: demoBankAccounts.map((a) => {
    const [accountName, bankName] = a.label.split(', ');
    return { id: a.id, accountName, bankName, last4: a.last4, isDefault: a.isDefault, archived: false };
  }),
  retentionDays: DEFAULT_RETENTION_DAYS,
  session: { ...DEFAULT_LIMITS },
  consent: false,
  signature: null,
}));
export const demoSettings = (): DemoSettings => demoBox.get();
export function resetDemoSettings(): void {
  demoBox.set(null);
}

export function demoSettingsView(): SettingsView {
  const st = demoSettings();
  const t = demoBusiness.tenant;
  const parts = t.addressLine.split(' · ');
  return {
    business: {
      name: t.name,
      companyNumber: t.companyNo,
      vatNumber: t.vatNo ?? '',
      phone: t.phone,
      email: t.email,
      website: t.web,
      addressLines: parts.slice(0, -1),
      postcode: parts[parts.length - 1] ?? '',
      ownerName: t.ownerName,
      ownerTitle: t.ownerTitle,
    },
    bankAccounts: st.accounts.map((a) => ({ ...a })),
    retentionDays: st.retentionDays,
    session: { ...st.session },
    signature: { consent: st.consent, hasImage: st.signature !== null },
  };
}

export function demoAddBankAccount(input: BankInput): BankAccountView {
  const st = demoSettings();
  const active = st.accounts.filter((a) => !a.archived);
  if (active.length >= MAX_ACTIVE_ACCOUNTS) throw new SettingsError('limit', `You can keep up to ${MAX_ACTIVE_ACCOUNTS} accounts. Archive one you no longer use first.`);
  // The numbers are used for nothing but the last four digits, then dropped: demo mode stores no bank numbers at all.
  const view: BankAccountView = { id: `demo-bank-${Date.now().toString(36)}`, accountName: input.accountName, bankName: input.bankName, last4: lastFour(input.accountNumber), isDefault: !active.some((a) => a.isDefault), archived: false };
  st.accounts.push(view);
  return view;
}

function demoFind(id: string): BankAccountView {
  const a = demoSettings().accounts.find((x) => x.id === id && !x.archived);
  if (!a) throw new SettingsError('not_found', 'That account could not be found.');
  return a;
}

export function demoRenameBankAccount(id: string, names: { accountName: string; bankName: string }): void {
  Object.assign(demoFind(id), names);
}

export function demoSetDefaultBankAccount(id: string): void {
  const a = demoFind(id);
  for (const x of demoSettings().accounts) x.isDefault = false;
  a.isDefault = true;
}

export function demoArchiveBankAccount(id: string): { newDefaultId: string | null } {
  const a = demoFind(id);
  const wasDefault = a.isDefault;
  a.archived = true;
  a.isDefault = false;
  const next = wasDefault ? demoSettings().accounts.find((x) => !x.archived) : undefined;
  if (next) next.isDefault = true;
  return { newDefaultId: next?.id ?? null };
}

/** Demo documents print the demo signature only with consent on and a picture stored, as in real mode. */
export function demoSignatureForDocuments(): string | null {
  const st = demoSettings();
  return st.consent && st.signature ? signatureDataUri(st.signature.png) : null;
}

/** The quote form's account list in demo mode: active accounts, default first, label with the last four only. */
export function demoBankOptions(): { id: string; label: string; last4: string; isDefault: boolean }[] {
  return demoSettings()
    .accounts.filter((a) => !a.archived)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map((a) => ({ id: a.id, label: bankLabel(a), last4: a.last4, isDefault: a.isDefault }));
}

// ---------------------------------------------------------------- what the screen calls

/** Owners and staff both read Settings; only owners see the controls (and only owners' changes are accepted). */
export async function getSettings(): Promise<SettingsView> {
  await requireSession();
  if (isDemo()) return demoSettingsView();
  return getSettingsWith(await ownerClient());
}
