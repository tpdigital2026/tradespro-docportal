import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { actAs, actAsServer, dbAvailable, withRollback } from './helpers';
import { seedTenant } from './seed';

async function expectFail(c: Client, sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await c.query('savepoint x');
  try {
    await expect(c.query(sql, params), sql).rejects.toThrow(pattern);
  } finally {
    await c.query('rollback to savepoint x');
  }
}

describe.skipIf(!dbAvailable)('002c draft locks', () => {
  it('while the document is a draft, the app role can edit a version and add a new one', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const upd = await c.query(`update public.document_versions set final_content = '{"x":1}', bank_account_id = $2 where id = $1`, [a.versionId, a.bankAccountId]);
      expect(upd.rowCount).toBe(1);
      await c.query(`insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 2)`, [a.tenantId, a.docId]);
    });
  });

  it('once the document leaves draft, the app role cannot edit its versions or add one; the server still can', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await c.query(`update public.documents set status = 'final' where id = $1`, [a.docId]);
      await actAs(c, a.userId);
      const locked = /no longer a draft/i;
      await expectFail(c, `update public.document_versions set final_content = '{"x":1}' where id = $1`, [a.versionId], locked);
      await expectFail(c, `update public.document_versions set bank_account_id = $2 where id = $1`, [a.versionId, a.bankAccountId], locked);
      await expectFail(c, `update public.document_versions set input = '{"x":1}' where id = $1`, [a.versionId], locked);
      await expectFail(c, `insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 2)`, [a.tenantId, a.docId], locked);
      await actAsServer(c);
      const fin = await c.query(`update public.document_versions set final_content = '{"ok":1}', finalised_at = now() where id = $1`, [a.versionId]);
      expect(fin.rowCount).toBe(1);
      await c.query(`insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 2)`, [a.tenantId, a.docId]);
    });
  });

  it('current_version_id must be a version of the same document', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      // A second draft document in the same tenant, with its own version.
      const doc2 = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RCP-QT-Alpha-001-D') returning id`, [a.tenantId, a.jobId]);
      const ver2 = await c.query(`insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 1) returning id`, [a.tenantId, doc2.rows[0].id]);
      await actAs(c, a.userId);
      await c.query('savepoint x');
      await c.query(`update public.documents set current_version_id = $1 where id = $2`, [ver2.rows[0].id, a.docId]);
      await expect(c.query('set constraints all immediate')).rejects.toThrow(/documents_current_version_same_document/);
      await c.query('rollback to savepoint x');
      await c.query(`update public.documents set current_version_id = $1 where id = $2`, [a.versionId, a.docId]);
      await c.query('set constraints all immediate');
      // And the server is held to the same rule.
      await actAsServer(c);
      await expectFail(c, `update public.documents set current_version_id = $1 where id = $2`, [ver2.rows[0].id, a.docId], /documents_current_version_same_document/);
    });
  });

  it('an email that has left draft cannot be edited by the app role; a draft can; the server can', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const draft = await c.query(`update public.document_emails set subject = 'Draft edit' where tenant_id = $1`, [a.tenantId]);
      expect(draft.rowCount).toBe(1);
      await actAsServer(c);
      await c.query(`update public.document_emails set status = 'sent', sent_at = now() where tenant_id = $1`, [a.tenantId]);
      await actAs(c, a.userId);
      const locked = /no longer a draft/i;
      await expectFail(c, `update public.document_emails set to_email = 'x@example.test' where tenant_id = $1`, [a.tenantId], locked);
      await expectFail(c, `update public.document_emails set subject = 'x' where tenant_id = $1`, [a.tenantId], locked);
      await expectFail(c, `update public.document_emails set body = 'x' where tenant_id = $1`, [a.tenantId], locked);
      await actAsServer(c);
      const server = await c.query(`update public.document_emails set status = 'failed' where tenant_id = $1`, [a.tenantId]);
      expect(server.rowCount).toBe(1);
    });
  });

  it('when the app role revokes a share link, the database sets the time', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      await c.query(`update public.share_links set revoked_at = now() + interval '100 years' where tenant_id = $1`, [a.tenantId]);
      const r = await c.query(`select abs(extract(epoch from revoked_at - now())) < 60 near from public.share_links where tenant_id = $1`, [a.tenantId]);
      expect(r.rows[0].near).toBe(true);
      await expectFail(c, `update public.share_links set revoked_at = null where tenant_id = $1`, [a.tenantId], /cannot be reinstated/i);
    });
  });
});
