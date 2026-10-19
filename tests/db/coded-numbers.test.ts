import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { connect } from '../../src/db/connect';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

/**
 * Migration 060: a quote QT-GW-001 gives INV-GW-001-D, RCP-GW-001-B, GC-GW-001 (the stem, without QT-), and the form built from the
 * whole quote number (INV-QT-GW-001-D) and legacy numbers (FJC1003) stay valid. These tests describe the migrated database; they
 * are skipped until 060 has been applied (npm run db:migrate), because the migration is what they test.
 */
async function migrated(): Promise<boolean> {
  if (!dbAvailable) return false;
  const c = await connect();
  try {
    const r = await c.query(`select 1 from public._migrations where name = '060_coded_document_numbers.sql'`);
    return r.rowCount === 1;
  } finally {
    await c.end();
  }
}
const isMigrated = await migrated();
if (dbAvailable && !isMigrated) console.warn('WARNING: tests/db/coded-numbers.test.ts is SKIPPED: migration 060 has not been applied to this database.');

async function jobWith(c: Client, reference: string) {
  const t = await createTenantWithUser(c, `Coded ${reference}`);
  const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'Coded Customer') returning id`, [t.tenantId]);
  const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`, [t.tenantId, cust.rows[0].id, reference]);
  return { ...t, customerId: cust.rows[0].id as string, jobId: job.rows[0].id as string };
}
const ins = `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, $3, $4)`;
async function accepts(c: Client, f: { tenantId: string; jobId: string }, type: string, number: string) {
  await c.query(ins, [f.tenantId, f.jobId, type, number]);
}
async function refuses(c: Client, f: { tenantId: string; jobId: string }, type: string, number: string) {
  await c.query('savepoint x');
  try {
    await expect(c.query(ins, [f.tenantId, f.jobId, type, number]), `${type} ${number}`).rejects.toThrow(/does not match its job and document type/);
  } finally {
    await c.query('rollback to savepoint x');
  }
}

describe.skipIf(!isMigrated)('document numbers built from the quote number\'s stem (migration 060)', () => {
  it('QT-GW-001 accepts INV-GW-001-D / -B, INV-GW-001, -S3, RCP-GW-001-D / -B / -P2 and GC-GW-001 / -G2', async () => {
    await withRollback(async (c) => {
      const f = await jobWith(c, 'QT-GW-001');
      await accepts(c, f, 'deposit_invoice', 'INV-GW-001-D');
      await accepts(c, f, 'balance_invoice', 'INV-GW-001-B');
      await accepts(c, f, 'invoice_full', 'INV-GW-001');
      await accepts(c, f, 'invoice_stage', 'INV-GW-001-S3');
      await accepts(c, f, 'receipt', 'RCP-GW-001-D');
      await accepts(c, f, 'receipt', 'RCP-GW-001-B');
      await accepts(c, f, 'receipt', 'RCP-GW-001-D-P2');
      await accepts(c, f, 'receipt', 'RCP-GW-001-S2');
      await accepts(c, f, 'guarantee', 'GC-GW-001');
      await accepts(c, f, 'guarantee', 'GC-GW-001-G2');
    });
  });

  it('refuses a number that belongs to another quote or another document type', async () => {
    await withRollback(async (c) => {
      const f = await jobWith(c, 'QT-GW-001');
      await refuses(c, f, 'deposit_invoice', 'INV-GW-002-D');
      await refuses(c, f, 'deposit_invoice', 'INV-GW-001-B');
      await refuses(c, f, 'balance_invoice', 'INV-GW-001-D');
      await refuses(c, f, 'receipt', 'RCP-XX-001-D');
      await refuses(c, f, 'receipt', 'INV-GW-001-D');
      await refuses(c, f, 'guarantee', 'GC-GW-002');
      await refuses(c, f, 'guarantee', 'GC-GW-001-G1');
      await refuses(c, f, 'invoice_stage', 'INV-GW-001-S11');
    });
  });

  it('still accepts the older form built from the whole quote number, so documents already made stay valid', async () => {
    await withRollback(async (c) => {
      const f = await jobWith(c, 'QT-AB-005');
      await accepts(c, f, 'deposit_invoice', 'INV-QT-AB-005-D');
      await accepts(c, f, 'receipt', 'RCP-QT-AB-005-D');
      await accepts(c, f, 'guarantee', 'GC-QT-AB-005');
    });
  });

  it('legacy quote numbers such as FJC1003 keep giving INV-FJC1003-D and GC-FJC1003', async () => {
    await withRollback(async (c) => {
      const f = await jobWith(c, 'FJC1003');
      await accepts(c, f, 'deposit_invoice', 'INV-FJC1003-D');
      await accepts(c, f, 'balance_invoice', 'INV-FJC1003-B');
      await accepts(c, f, 'guarantee', 'GC-FJC1003');
      await refuses(c, f, 'deposit_invoice', 'INV-QT-FJC1003-D-X');
    });
  });

  it('a revision ending is carried through: QT-GW-001-1 gives INV-GW-001-1-B', async () => {
    await withRollback(async (c) => {
      const f = await jobWith(c, 'QT-GW-001-1');
      await accepts(c, f, 'balance_invoice', 'INV-GW-001-1-B');
    });
  });

  it('two jobs that would give the same invoice number (QT-GW-009 and GW-009) cannot both use it', async () => {
    await withRollback(async (c) => {
      const f = await jobWith(c, 'QT-GW-009');
      await accepts(c, f, 'deposit_invoice', 'INV-GW-009-D');
      const other = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'GW-009') returning id`, [f.tenantId, f.customerId]);
      await c.query('savepoint y');
      try {
        await expect(c.query(ins, [f.tenantId, other.rows[0].id, 'deposit_invoice', 'INV-GW-009-D'])).rejects.toThrow(/already been used/);
      } finally {
        await c.query('rollback to savepoint y');
      }
    });
  });
});
