import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connect } from '../../src/db/connect';
import { createTenantWithUser, dbAvailable } from './helpers';

describe.skipIf(!dbAvailable)('draft lock reads the status under a share lock', () => {
  it('a version insert waits for a concurrent finalise, then is refused', async () => {
    const setup = await connect();
    const finaliser = await connect();
    const app = await connect();
    let tenantId: string | undefined;
    let userId: string | undefined;
    let primary: unknown;
    try {
      const t = await createTenantWithUser(setup, `ShareLockTest ${randomUUID().slice(0, 8)}`);
      tenantId = t.tenantId;
      userId = t.userId;
      const cust = await setup.query(`insert into public.customers (tenant_id, name) values ($1, 'C') returning id`, [tenantId]);
      const job = await setup.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-SL-001') returning id`, [tenantId, cust.rows[0].id]);
      const doc = await setup.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', 'QT-SL-001') returning id`, [tenantId, job.rows[0].id]);
      const docId = doc.rows[0].id as string;

      await finaliser.query('begin');
      await finaliser.query(`select 1 from public.documents where id = $1 for update`, [docId]);
      await app.query('begin');
      await app.query('set local role authenticated');
      await app.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
      const pid = (await app.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      const pending = app
        .query(`insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 1)`, [tenantId, docId])
        .then(() => null, (e) => e as { code?: string; message: string });
      let blocked = false;
      for (let i = 0; i < 50 && !blocked; i++) {
        blocked = (await setup.query(`select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [pid])).rows.length > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 100));
      }
      expect(blocked, 'the version insert should wait for the finalise').toBe(true);
      await finaliser.query(`update public.documents set status = 'final' where id = $1`, [docId]);
      await finaliser.query('commit');
      const err = await pending;
      expect(err?.code).toBe('42501');
      expect(err?.message).toMatch(/no longer a draft/i);
    } catch (e) {
      primary = e;
    }
    const errors: unknown[] = [];
    await app.query('rollback').catch(() => undefined);
    await finaliser.query('rollback').catch(() => undefined);
    try {
      if (tenantId) {
        // A fixture document that left draft can only go with the purge flag (070), as in a real business.
        await setup.query('begin');
        await setup.query(`select set_config('app.allow_final_delete', 'on', true)`);
        await setup.query(`delete from public.tenants where id = $1`, [tenantId]);
        await setup.query('commit');
        await setup.query(`delete from auth.users where id = $1`, [userId]);
        const left = await setup.query(`select count(*)::int n from public.tenants where id = $1`, [tenantId]);
        if (left.rows[0].n !== 0) errors.push(new Error('ShareLockTest tenant left behind'));
      }
    } catch (e) {
      errors.push(e);
    }
    for (const c of [app, finaliser, setup]) await c.end().catch((e) => errors.push(e));
    if (primary) throw errors.length ? new AggregateError([primary, ...errors], 'test and cleanup failed') : primary;
    if (errors.length) throw new AggregateError(errors, 'cleanup failed');
  });
});
