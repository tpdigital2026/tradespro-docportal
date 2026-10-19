'use server';

import { cookies } from 'next/headers';
import { cookieOptions, readSessionStart, sessionSecret, SESSION_MAX_AGE_SECONDS, startCookieName } from '../../../lib/auth-cookies';
import { withServiceConnection } from '../../../lib/data/customer-admin';
import {
  addBankAccountWith,
  archiveBankAccountWith,
  bankKey,
  bankLabel,
  demoAddBankAccount,
  demoArchiveBankAccount,
  demoRenameBankAccount,
  demoSetDefaultBankAccount,
  demoSetPaymentWording,
  demoSettings,
  removeSignatureWith,
  renameBankAccountWith,
  setDefaultBankAccountWith,
  setPaymentWordingWith,
  setRetentionWith,
  setSessionPolicyWith,
  setSignatureConsentWith,
  SettingsError,
} from '../../../lib/data/settings';
import { isDemo } from '../../../lib/demo';
import { parsePaymentWording, type PaymentWordingField } from '../../../lib/payment-wording';
import { requireSession, type Session } from '../../../lib/session';
import { activityCookieName, readActivity, signActivity, type SessionLimits } from '../../../lib/session-policy';
import { requireFreshStepUpForRequest, StepUpRequiredError } from '../../../lib/step-up-check';
import { getStorage } from '../../../lib/storage';
import { fieldErrors, parseBankAccount, parseBankNames, retentionSchema, sessionPolicySchema, UUID_RE } from '../../../lib/validation/settings';

export type SettingsResult =
  | { status: 'ok'; message: string }
  | { status: 'step-up' }
  | { status: 'invalid'; errors: Record<string, string> }
  | { status: 'error'; message: string };

const GENERIC = 'That could not be saved. Nothing was changed. Please try again.';
const OWNER_ONLY = 'Only the owner can change this.';

const validId = (id: unknown): id is string => typeof id === 'string' && (isDemo() ? /^demo-bank-[a-z0-9-]{1,40}$/.test(id) || UUID_RE.test(id) : UUID_RE.test(id));

/**
 * Every change on this screen: the session (tenant and role from the server, never the browser), owner only, the
 * input checked, then a fresh emailed code (the browser runs the code step when this answers 'step-up' and calls again
 * with the same input), then the write. Bank numbers are never echoed back, logged or kept after the write.
 */
async function guarded(o: { stepUp: boolean }, write: (s: Session) => Promise<string>): Promise<SettingsResult> {
  const s = await requireSession();
  if (s.role !== 'owner') return { status: 'error', message: OWNER_ONLY };
  if (o.stepUp) {
    try {
      await requireFreshStepUpForRequest();
    } catch (e) {
      if (e instanceof StepUpRequiredError) return { status: 'step-up' };
      return { status: 'error', message: GENERIC };
    }
  }
  try {
    return { status: 'ok', message: await write(s) };
  } catch (e) {
    if (e instanceof SettingsError) return { status: 'error', message: e.message };
    // Name only: the error text could carry a query parameter.
    console.error(`settings write failed: ${e instanceof Error ? e.name : 'Error'}`);
    return { status: 'error', message: GENERIC };
  }
}

const actor = (s: Session) => ({ tenantId: s.tenantId, userId: s.userId });

export async function addBankAccountAction(raw: { accountName?: unknown; bankName?: unknown; sortCode?: unknown; accountNumber?: unknown }): Promise<SettingsResult> {
  const s0 = await requireSession();
  if (s0.role !== 'owner') return { status: 'error', message: OWNER_ONLY };
  const parsed = parseBankAccount(raw ?? {});
  if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };
  return guarded({ stepUp: true }, async (s) => {
    const saved = isDemo() ? demoAddBankAccount(parsed.value) : await withServiceConnection((db) => addBankAccountWith(db, actor(s), parsed.value, bankKey()));
    return `${bankLabel(saved)} is saved${saved.isDefault ? ' and is your default account' : ''}.`;
  });
}

export async function renameBankAccountAction(id: string, raw: { accountName?: unknown; bankName?: unknown }): Promise<SettingsResult> {
  const s0 = await requireSession();
  if (s0.role !== 'owner') return { status: 'error', message: OWNER_ONLY };
  if (!validId(id)) return { status: 'error', message: GENERIC };
  const parsed = parseBankNames(raw ?? {});
  if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };
  return guarded({ stepUp: true }, async (s) => {
    if (isDemo()) demoRenameBankAccount(id, parsed.value);
    else await withServiceConnection((db) => renameBankAccountWith(db, actor(s), id, parsed.value));
    return 'The account name is updated.';
  });
}

export async function setDefaultBankAccountAction(id: string): Promise<SettingsResult> {
  if (!validId(id)) return { status: 'error', message: GENERIC };
  return guarded({ stepUp: true }, async (s) => {
    if (isDemo()) demoSetDefaultBankAccount(id);
    else await withServiceConnection((db) => setDefaultBankAccountWith(db, actor(s), id));
    return 'New invoices will ask to be paid into this account unless you choose another on the quote.';
  });
}

export async function archiveBankAccountAction(id: string): Promise<SettingsResult> {
  if (!validId(id)) return { status: 'error', message: GENERIC };
  return guarded({ stepUp: true }, async (s) => {
    const r = isDemo() ? demoArchiveBankAccount(id) : await withServiceConnection((db) => archiveBankAccountWith(db, actor(s), id));
    return r.newDefaultId
      ? 'The account is archived. Documents already made with it keep it. Your oldest other account is now the default.'
      : 'The account is archived. Documents already made with it keep it.';
  });
}

export async function setRetentionAction(raw: { days?: unknown }): Promise<SettingsResult> {
  const s0 = await requireSession();
  if (s0.role !== 'owner') return { status: 'error', message: OWNER_ONLY };
  const parsed = retentionSchema.safeParse(raw ?? {});
  if (!parsed.success) return { status: 'invalid', errors: fieldErrors(parsed.error.issues) };
  const days = parsed.data.days;
  return guarded({ stepUp: true }, async (s) => {
    let previous: number;
    let extended: number | null = null;
    if (isDemo()) {
      previous = demoSettings().retentionDays;
      demoSettings().retentionDays = days;
    } else {
      const r = await withServiceConnection((db) => setRetentionWith(db, actor(s), days));
      previous = r.previous;
      extended = r.extended;
    }
    return retentionMessage(days, previous, extended);
  });
}

/** What the owner is told after changing how long customer data is kept: honest about which dates moved. */
function retentionMessage(days: number, previous: number, extended: number | null): string {
  const base = `Customer data is now kept for ${days} days after the last activity.`;
  if (days > previous) {
    if (extended === null) return `${base} Customers already on file get the longer time too.`;
    return `${base} ${extended === 1 ? '1 customer already on file was' : `${extended} customers already on file were`} given the longer time.`;
  }
  if (days < previous) return `${base} Customers already on file keep their current deletion date until something happens on their record.`;
  return base;
}

/** The signed-in owner's own activity cookie carries the new limits straight away (others' from their next sign-in). */
async function reissueOwnActivity(s: Session, limits: SessionLimits): Promise<void> {
  try {
    const jar = await cookies();
    const secret = sessionSecret();
    const now = Math.floor(Date.now() / 1000);
    const start = readSessionStart(secret, jar.get(startCookieName())?.value, now);
    if (!start || start.userId !== s.userId) return;
    const name = activityCookieName(start.sessionId);
    const act = readActivity(secret, jar.get(name)?.value);
    if (!act || act.userId !== s.userId || act.sessionId !== start.sessionId) return;
    jar.set(name, signActivity(secret, { ...act, lastAt: now, ...limits }), cookieOptions(SESSION_MAX_AGE_SECONDS));
  } catch {
    /* the database is the truth; getSession enforces it either way */
  }
}

export async function setSessionPolicyAction(raw: { idleMinutes?: unknown; maxDays?: unknown }): Promise<SettingsResult> {
  const s0 = await requireSession();
  if (s0.role !== 'owner') return { status: 'error', message: OWNER_ONLY };
  const parsed = sessionPolicySchema.safeParse(raw ?? {});
  if (!parsed.success) return { status: 'invalid', errors: fieldErrors(parsed.error.issues) };
  const limits = parsed.data;
  return guarded({ stepUp: true }, async (s) => {
    if (isDemo()) demoSettings().session = { ...limits };
    else {
      await withServiceConnection((db) => setSessionPolicyWith(db, actor(s), limits));
      await reissueOwnActivity(s, limits);
    }
    return "Saved. Shorter limits apply to everyone straight away; longer ones from each person's next sign-in.";
  });
}

/** Switching printing on needs a fresh code; switching it off never does. */
export async function setSignatureConsentAction(on: boolean): Promise<SettingsResult> {
  if (typeof on !== 'boolean') return { status: 'error', message: GENERIC };
  return guarded({ stepUp: on }, async (s) => {
    if (isDemo()) {
      const st = demoSettings();
      if (on && !st.signature) throw new SettingsError('invalid', 'Add a picture of your signature first.');
      st.consent = on;
    } else await withServiceConnection((db) => setSignatureConsentWith(db, actor(s), on));
    return on ? 'Your signature will be printed on documents you finalise from now on.' : 'Your signature will not be printed. Documents keep a line to sign by hand.';
  });
}

export async function removeSignatureAction(): Promise<SettingsResult> {
  return guarded({ stepUp: false }, async (s) => {
    if (isDemo()) Object.assign(demoSettings(), { signature: null, consent: false });
    else await withServiceConnection((db) => removeSignatureWith(db, getStorage(), actor(s)));
    return 'Your signature picture is deleted and will not be printed.';
  });
}

/** The wording on deposit and balance invoices (the Due line, the note and terms, and what the payment reference says). Owner only, fresh code, audited. */
export async function setPaymentWordingAction(raw: Partial<Record<PaymentWordingField, unknown>>): Promise<SettingsResult> {
  const s0 = await requireSession();
  if (s0.role !== 'owner') return { status: 'error', message: OWNER_ONLY };
  const parsed = parsePaymentWording(raw ?? {});
  if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };
  return guarded({ stepUp: true }, async (s) => {
    const r = isDemo() ? demoSetPaymentWording(parsed.value) : await withServiceConnection((db) => setPaymentWordingWith(db, actor(s), parsed.value));
    return r.changed.length === 0 ? 'Nothing was different, so nothing changed.' : 'Saved. Invoices you finalise from now on use this wording. Invoices already finalised keep the wording they were made with.';
  });
}
