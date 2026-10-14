import { createHmac } from 'node:crypto';

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES = 5;
export const MAX_CODE_REQUESTS = 5;
export const IP_MAX_FAILURES = 20;

export interface Attempt {
  kind: 'request' | 'verify';
  success: boolean;
  at: Date;
}

export interface Decision {
  allowed: boolean;
  reason: 'ok' | 'locked' | 'too_many_codes' | 'ip_blocked';
  retryAt: Date | null;
}

const OK: Decision = { allowed: true, reason: 'ok', retryAt: null };

export const IP_MAX_REQUESTS = 30;
export const MIN_PEPPER_LENGTH = 32;

export function hashEmail(email: string, pepper: string): string {
  if (typeof pepper !== 'string' || pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error(`login pepper must be at least ${MIN_PEPPER_LENGTH} characters`);
  }
  const normalised = email.trim().toLowerCase();
  if (!normalised) throw new Error('email must not be empty');
  return createHmac('sha256', pepper).update(normalised).digest('hex');
}

/**
 * Five wrong codes within 15 minutes starts a lock that lasts 15 minutes from the
 * failure that triggered it; each further wrong code extends it. A success clears
 * earlier failures, but a success recorded while locked is ignored: callers must use
 * verifyWithGuard, which never accepts a code during a lock.
 */
export function decideVerify(attempts: Attempt[], now: Date): Decision {
  const verifies = attempts.filter((a) => a.kind === 'verify').sort((a, b) => a.at.getTime() - b.at.getTime());
  let window: number[] = [];
  let lockUntil = 0;
  for (const a of verifies) {
    const t = a.at.getTime();
    if (a.success) {
      if (lockUntil > t) continue;
      window = [];
      lockUntil = 0;
      continue;
    }
    window.push(t);
    window = window.filter((w) => w > t - WINDOW_MS);
    if (t < lockUntil || window.length >= MAX_FAILURES) lockUntil = t + WINDOW_MS;
  }
  return lockUntil > now.getTime() ? { allowed: false, reason: 'locked', retryAt: new Date(lockUntil) } : OK;
}

/** At most five code emails per address per 15 minutes. */
export function decideRequest(attempts: Attempt[], now: Date): Decision {
  const since = now.getTime() - WINDOW_MS;
  const requests = attempts
    .filter((a) => a.kind === 'request' && a.at.getTime() > since)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (requests.length < MAX_CODE_REQUESTS) return OK;
  return {
    allowed: false,
    reason: 'too_many_codes',
    retryAt: new Date(requests[requests.length - MAX_CODE_REQUESTS].at.getTime() + WINDOW_MS),
  };
}

export function decideIp(ipFailuresInWindow: number): Decision {
  return ipFailuresInWindow >= IP_MAX_FAILURES ? { allowed: false, reason: 'ip_blocked', retryAt: null } : OK;
}

export function decideIpRequests(ipRequestsInWindow: number): Decision {
  return ipRequestsInWindow >= IP_MAX_REQUESTS ? { allowed: false, reason: 'ip_blocked', retryAt: null } : OK;
}

export type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export async function recordAttempt(
  db: Db,
  a: { emailHash: string; ip: string | null; kind: 'request' | 'verify'; success: boolean },
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(a.emailHash)) throw new Error('emailHash must be a 64 character hex hash');
  await db.query(`insert into public.login_attempts (email_hash, ip, kind, success) values ($1, $2, $3, $4)`, [
    a.emailHash,
    a.ip,
    a.kind,
    a.success,
  ]);
}

/** Looks back two windows so a lock started up to 15 minutes ago is still visible. */
export async function recentAttempts(db: Db, emailHash: string, now: Date): Promise<Attempt[]> {
  const since = new Date(now.getTime() - 2 * WINDOW_MS);
  const r = await db.query(
    `select kind, success, at from public.login_attempts where email_hash = $1 and at > $2 order by at desc limit 200`,
    [emailHash, since],
  );
  return r.rows.map((x) => ({ kind: x.kind, success: x.success, at: new Date(x.at) })).sort((a, b) => a.at.getTime() - b.at.getTime());
}

export async function recentIpFailures(db: Db, ip: string | null, now: Date): Promise<number> {
  if (!ip) return 0;
  const since = new Date(now.getTime() - WINDOW_MS);
  const r = await db.query(
    `select count(*)::int as n from public.login_attempts where ip = $1 and kind = 'verify' and success = false and at > $2`,
    [ip, since],
  );
  return r.rows[0].n;
}

export async function recentIpRequests(db: Db, ip: string | null, now: Date): Promise<number> {
  if (!ip) return 0;
  const since = new Date(now.getTime() - WINDOW_MS);
  const r = await db.query(`select count(*)::int as n from public.login_attempts where ip = $1 and kind = 'request' and at > $2`, [ip, since]);
  return r.rows[0].n;
}

interface GuardInput {
  emailHash: string;
  ip: string | null;
  now?: Date;
  /** Set when the caller already owns a transaction (tests); skips begin/commit/rollback. */
  inTransaction?: boolean;
}

async function inGuardTransaction<T>(db: Db, input: GuardInput, fn: () => Promise<T>): Promise<T> {
  const own = !input.inTransaction;
  if (own) await db.query('begin');
  try {
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [input.emailHash]);
    const result = await fn();
    if (own) await db.query('commit');
    return result;
  } catch (e) {
    if (own) await db.query('rollback').catch(() => undefined);
    throw e;
  }
}

/**
 * Checks the limits, runs checkCode and records the outcome under one per-email lock, so
 * concurrent guesses cannot slip past the limit. checkCode is never called while blocked.
 */
export async function verifyWithGuard(
  db: Db,
  input: GuardInput & { checkCode: () => Promise<boolean> },
): Promise<{ outcome: 'verified' } | { outcome: 'wrong_code' } | { outcome: 'blocked'; decision: Decision }> {
  const now = input.now ?? new Date();
  return inGuardTransaction(db, input, async () => {
    const ipDecision = decideIp(await recentIpFailures(db, input.ip, now));
    if (!ipDecision.allowed) return { outcome: 'blocked' as const, decision: ipDecision };
    const decision = decideVerify(await recentAttempts(db, input.emailHash, now), now);
    if (!decision.allowed) return { outcome: 'blocked' as const, decision };
    const ok = await input.checkCode();
    await recordAttempt(db, { emailHash: input.emailHash, ip: input.ip, kind: 'verify', success: ok });
    return ok ? { outcome: 'verified' as const } : { outcome: 'wrong_code' as const };
  });
}

/** Same shape for code requests: records a request only when it is allowed. */
export async function requestCodeWithGuard(
  db: Db,
  input: GuardInput,
): Promise<{ outcome: 'allowed' } | { outcome: 'blocked'; decision: Decision }> {
  const now = input.now ?? new Date();
  return inGuardTransaction(db, input, async () => {
    const ipDecision = decideIpRequests(await recentIpRequests(db, input.ip, now));
    if (!ipDecision.allowed) return { outcome: 'blocked' as const, decision: ipDecision };
    const decision = decideRequest(await recentAttempts(db, input.emailHash, now), now);
    if (!decision.allowed) return { outcome: 'blocked' as const, decision };
    await recordAttempt(db, { emailHash: input.emailHash, ip: input.ip, kind: 'request', success: true });
    return { outcome: 'allowed' as const };
  });
}
