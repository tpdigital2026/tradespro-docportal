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

export function hashEmail(email: string, pepper: string): string {
  return createHmac('sha256', pepper).update(email.trim().toLowerCase()).digest('hex');
}

/** Five wrong codes in 15 minutes locks the account until 15 minutes after the latest wrong code. */
export function decideVerify(attempts: Attempt[], now: Date): Decision {
  const since = now.getTime() - WINDOW_MS;
  const verifies = attempts.filter((a) => a.kind === 'verify').sort((a, b) => a.at.getTime() - b.at.getTime());
  const lastSuccess = [...verifies].reverse().find((a) => a.success)?.at.getTime() ?? -Infinity;
  const failures = verifies.filter((a) => !a.success && a.at.getTime() > since && a.at.getTime() > lastSuccess);
  if (failures.length < MAX_FAILURES) return OK;
  const retryAt = new Date(failures[failures.length - 1].at.getTime() + WINDOW_MS);
  return retryAt.getTime() > now.getTime() ? { allowed: false, reason: 'locked', retryAt } : OK;
}

/** At most five code emails per address per 15 minutes. */
export function decideRequest(attempts: Attempt[], now: Date): Decision {
  const since = now.getTime() - WINDOW_MS;
  const requests = attempts
    .filter((a) => a.kind === 'request' && a.at.getTime() > since)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (requests.length < MAX_CODE_REQUESTS) return OK;
  return { allowed: false, reason: 'too_many_codes', retryAt: new Date(requests[0].at.getTime() + WINDOW_MS) };
}

export function decideIp(ipFailuresInWindow: number): Decision {
  return ipFailuresInWindow >= IP_MAX_FAILURES ? { allowed: false, reason: 'ip_blocked', retryAt: null } : OK;
}

export type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export async function recordAttempt(
  db: Db,
  a: { emailHash: string; ip: string | null; kind: 'request' | 'verify'; success: boolean },
): Promise<void> {
  await db.query(`insert into public.login_attempts (email_hash, ip, kind, success) values ($1, $2, $3, $4)`, [
    a.emailHash,
    a.ip,
    a.kind,
    a.success,
  ]);
}

export async function recentAttempts(db: Db, emailHash: string, now: Date): Promise<Attempt[]> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const r = await db.query(`select kind, success, at from public.login_attempts where email_hash = $1 and at > $2 order by at`, [emailHash, since]);
  return r.rows.map((x) => ({ kind: x.kind, success: x.success, at: new Date(x.at) }));
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
