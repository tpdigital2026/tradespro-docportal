import { purgeExpiredWith, withServiceConnection } from '../../../../lib/data/customer-admin';
import { handleMaintenance, type MaintenanceDeps } from '../../../../lib/maintenance/cron';
import { sweepOrphansWith } from '../../../../lib/maintenance/orphan-sweep';
import { getStorage } from '../../../../lib/storage';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const deps: MaintenanceDeps = {
  secret: () => process.env.CRON_SECRET?.trim(),
  // One transaction, no app JWT, a five minute statement timeout (purgeExpiredWith clears the claims itself).
  purgeCustomers: () => withServiceConnection((db) => purgeExpiredWith(db, getStorage(), { statementTimeoutSeconds: 300 })),
  purgeLoginAttempts: () =>
    withServiceConnection(async (db) => {
      await db.query('reset role');
      await db.query(`select set_config('request.jwt.claims', '', false)`);
      const r = await db.query('select private.purge_old_login_attempts() as n');
      return Number(r.rows[0]?.n ?? 0);
    }),
  sweep: (dryRun) => withServiceConnection((db) => sweepOrphansWith(db, getStorage(), { dryRun })),
  log: (line) => console.log(line),
};

/** Vercel Cron calls this with GET and the CRON_SECRET bearer token. */
export function GET(req: Request) {
  return handleMaintenance(req, deps);
}
