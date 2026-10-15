import { describe, expect, it } from 'vitest';
import { seedFjc } from '../../src/db/seed-fjc';
import { parseScopeExamples } from '../../src/lib/scope/examples';
import { actAs, createTenantWithUser, dbAvailable, withRollback } from './helpers';

describe.skipIf(!dbAvailable)('job_types.scope_examples (migration 010)', () => {
  it('the FJC seed fills it for every job type, and the app can parse every value', async () => {
    await withRollback(async (c) => {
      await c.query(`delete from public.tenants where name = 'FJC Roofing Ltd'`);
      const { tenantId } = await seedFjc(c);
      const rows = await c.query(`select key, scope_examples from public.job_types where tenant_id = $1 order by key`, [tenantId]);
      expect(rows.rows.map((r) => r.key)).toEqual(['fascia', 'flat_roof', 'other', 'tiled_roof']);
      for (const r of rows.rows) expect(parseScopeExamples(r.scope_examples), r.key).not.toBeNull();
      expect(rows.rows.find((r) => r.key === 'flat_roof')!.scope_examples.sequences.length).toBeGreaterThan(0);
    });
  });

  it('a second seed fills only what is empty and never overwrites the business\'s own edits', async () => {
    await withRollback(async (c) => {
      await c.query(`delete from public.tenants where name = 'FJC Roofing Ltd'`);
      const { tenantId } = await seedFjc(c);
      await c.query(`update public.job_types set scope_examples = '{"specLabels":[],"headings":["Mine"],"starters":[],"sequences":[]}' where tenant_id = $1 and key = 'flat_roof'`, [tenantId]);
      await c.query(`update public.job_types set scope_examples = null where tenant_id = $1 and key = 'tiled_roof'`, [tenantId]);
      await seedFjc(c);
      const rows = await c.query(`select key, scope_examples from public.job_types where tenant_id = $1`, [tenantId]);
      const by = Object.fromEntries(rows.rows.map((r) => [r.key, r.scope_examples]));
      expect(by.flat_roof.headings).toEqual(['Mine']);
      expect(by.tiled_roof.headings.length).toBeGreaterThan(0);
    });
  });

  it('must be a json object of sensible size', async () => {
    await withRollback(async (c) => {
      const { tenantId } = await createTenantWithUser(c, 'Scope Test Co');
      await c.query('savepoint a');
      await expect(c.query(`insert into public.job_types (tenant_id, key, label, scope_examples) values ($1, 'x_one', 'X', '[1]')`, [tenantId])).rejects.toThrow(/job_types_scope_examples_shape/);
      await c.query('rollback to savepoint a');
      await c.query('savepoint b');
      await expect(c.query(`insert into public.job_types (tenant_id, key, label, scope_examples) values ($1, 'x_two', 'X', to_jsonb(repeat('a', 40000)))`, [tenantId])).rejects.toThrow(/job_types_scope_examples_shape/);
      await c.query('rollback to savepoint b');
      await c.query(`insert into public.job_types (tenant_id, key, label, scope_examples) values ($1, 'x_three', 'X', '{}')`, [tenantId]);
    });
  });

  it('a business sees only its own wording, and cannot read another business\'s', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Scope Co A');
      const b = await createTenantWithUser(c, 'Scope Co B');
      await c.query(`insert into public.job_types (tenant_id, key, label, scope_examples) values ($1, 'roof', 'Roof A', '{"headings":["A only"]}'), ($2, 'roof', 'Roof B', '{"headings":["B only"]}')`, [a.tenantId, b.tenantId]);
      await actAs(c, a.userId);
      const seen = await c.query(`select label, scope_examples from public.job_types`);
      expect(seen.rows).toEqual([{ label: 'Roof A', scope_examples: { headings: ['A only'] } }]);
    });
  });

  it('saving a quote draft with a scope keeps it in the version input', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Scope Co C');
      const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'Scope Customer') returning id`, [t.tenantId]);
      const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'SCOPE-1') returning id`, [t.tenantId, cust.rows[0].id]);
      const doc = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', 'SCOPE-1') returning id`, [t.tenantId, job.rows[0].id]);
      const input = { schema: 1, form: { scope: { items: [{ id: 'a1', kind: 'step', text: 'Do it.' }], copy: { engine: 'fallback', approvedAt: '2026-10-15T09:00:00.000Z' } } } };
      const ver = await c.query(`insert into public.document_versions (tenant_id, document_id, version, input) values ($1, $2, 1, $3) returning input`, [t.tenantId, doc.rows[0].id, JSON.stringify(input)]);
      expect(ver.rows[0].input.form.scope.copy.engine).toBe('fallback');
    });
  });
});
