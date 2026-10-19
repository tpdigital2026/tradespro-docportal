/**
 * The daily maintenance job, called by Vercel Cron (vercel.json, 03:15 UTC) at /api/cron/maintenance with
 * `Authorization: Bearer ${CRON_SECRET}`. Without that exact secret it answers 401 and does nothing.
 *
 * In order, each step on its own service connection, each allowed to fail without stopping the next:
 *   1. the customer purge protocol (README "Purge job protocol": claim_expired_customers, expired_storage_paths, delete
 *      the files with the real storage client, purge_customers, all in ONE transaction with no request.jwt.claims and a
 *      generous statement timeout; any storage failure rolls the database step back);
 *   2. private.purge_unlinked_appointments(now()) (appointments with no customer past the retention period; it touches
 *      no files; migration 031);
 *   3. private.purge_old_login_attempts (sign-in attempt rows older than 30 days);
 *   4. the storage orphan sweep (dry run with ?dry=1).
 * Logs and the answer hold counts only.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { Db } from '../../security/login-guard';
import type { SweepResult } from './orphan-sweep';

/** Step 2: on a service connection with no app role or claims (the function is granted to the service role only). */
export async function purgeUnlinkedAppointmentsWith(db: Db): Promise<number> {
  await db.query('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  const r = await db.query('select private.purge_unlinked_appointments(now()) as n');
  return Number(r.rows[0]?.n ?? 0);
}

export interface MaintenanceDeps {
  secret(): string | undefined;
  purgeCustomers(): Promise<number>;
  purgeUnlinkedAppointments(): Promise<number>;
  purgeLoginAttempts(): Promise<number>;
  sweep(dryRun: boolean): Promise<SweepResult>;
  log(line: string): void;
}

const MIN_SECRET = 32;
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time check of the bearer token (both sides hashed first, so lengths never leak through timing). */
export function cronAuthorised(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_SECRET || !header) return false;
  const m = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header);
  const given = digest(m ? m[1] : '');
  return timingSafeEqual(given, digest(secret)) && m !== null;
}

const errName = (e: unknown) => (e instanceof Error ? e.name : 'Error') + (typeof (e as { code?: unknown })?.code === 'string' && /^[\w-]{1,16}$/.test((e as { code: string }).code) ? ` ${(e as { code: string }).code}` : '');

export async function handleMaintenance(req: Request, deps: MaintenanceDeps): Promise<Response> {
  const secret = deps.secret();
  if (!secret || secret.length < MIN_SECRET) deps.log('maintenance: CRON_SECRET is not set (or too short); refusing');
  if (!cronAuthorised(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ ok: false }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const dryRun = new URL(req.url).searchParams.get('dry') === '1';
  const result: Record<string, unknown> = {};
  let ok = true;
  const step = async <T>(name: string, run: () => Promise<T>, summary: (v: T) => Record<string, unknown>) => {
    try {
      const v = await run();
      result[name] = { ok: true, ...summary(v) };
      deps.log(`maintenance ${name}: ${JSON.stringify(summary(v))}`);
    } catch (e) {
      ok = false;
      result[name] = { ok: false };
      deps.log(`maintenance ${name} failed: ${errName(e)}`);
    }
  };
  await step('purge', deps.purgeCustomers, (n) => ({ customers: n }));
  await step('appointments', deps.purgeUnlinkedAppointments, (n) => ({ deleted: n }));
  await step('loginAttempts', deps.purgeLoginAttempts, (n) => ({ deleted: n }));
  await step('orphans', () => deps.sweep(dryRun), (r) => ({ ...r }));
  return NextResponse.json({ ok, ...result }, { status: ok ? 200 : 500, headers: { 'Cache-Control': 'no-store' } });
}
