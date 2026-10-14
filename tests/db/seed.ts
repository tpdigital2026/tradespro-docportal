import type { Client } from 'pg';
import { createTenantWithUser } from './helpers';

export type SeededTenant = {
  tenantId: string;
  userId: string;
  customerId: string;
  jobId: string;
  docId: string;
  versionId: string;
  kitId: string;
  assetId: string;
  bankAccountId: string;
};

/** Seeds one business with a row in every tenant table. Runs as the server role (bypasses row level security). */
export async function seedTenant(c: Client, name: string): Promise<SeededTenant> {
  const t = await createTenantWithUser(c, name);
  const slug = name.replace(/\W/g, '');
  const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, $2) returning id`, [t.tenantId, `${name} Customer`]);
  const job = await c.query(
    `insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`,
    [t.tenantId, cust.rows[0].id, `QT-${slug}-001`],
  );
  const doc = await c.query(
    `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', $3) returning id`,
    [t.tenantId, job.rows[0].id, `QT-${slug}-001`],
  );
  const ver = await c.query(
    `insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 1) returning id`,
    [t.tenantId, doc.rows[0].id],
  );
  const bank = await c.query(
    `insert into public.bank_accounts (tenant_id, account_name, bank_name, sort_code_enc, account_number_enc, last4) values ($1, 'Acc', 'Bank', 'enc', 'enc', '1234') returning id`,
    [t.tenantId],
  );
  const kit = await c.query(`insert into public.brand_kits (tenant_id) values ($1) returning id`, [t.tenantId]);
  const asset = await c.query(
    `insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, 'logo_colour', 'logo.png') returning id`,
    [t.tenantId, kit.rows[0].id],
  );
  await c.query(`insert into public.job_types (tenant_id, key, label) values ($1, 'flat_roof', 'Flat roof')`, [t.tenantId]);
  await c.query(`insert into public.tenant_defaults (tenant_id) values ($1)`, [t.tenantId]);
  await c.query(`insert into public.job_photos (tenant_id, job_id, storage_path) values ($1, $2, 'photo.jpg')`, [t.tenantId, job.rows[0].id]);
  await c.query(
    `insert into public.share_links (tenant_id, document_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '7 days')`,
    [t.tenantId, doc.rows[0].id, `hash-${t.tenantId}`],
  );
  await c.query(`insert into public.document_emails (tenant_id, document_id) values ($1, $2)`, [t.tenantId, doc.rows[0].id]);
  await c.query(`insert into public.ai_runs (tenant_id, document_id, model) values ($1, $2, 'test-model')`, [t.tenantId, doc.rows[0].id]);
  await c.query(`insert into public.audit_log (tenant_id, action) values ($1, 'test')`, [t.tenantId]);
  return {
    ...t,
    customerId: cust.rows[0].id as string,
    jobId: job.rows[0].id as string,
    docId: doc.rows[0].id as string,
    versionId: ver.rows[0].id as string,
    kitId: kit.rows[0].id as string,
    assetId: asset.rows[0].id as string,
    bankAccountId: bank.rows[0].id as string,
  };
}
