import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auditedApprovalWith } from '../../src/lib/data/scope';
import { compactId } from '../../src/lib/data/customer-admin';
import { approvalHash } from '../../src/lib/scope/model';
import { writeAudit } from '../../src/security/audit';
import { approvedScope } from '../fixtures/scope';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

describe.skipIf(!dbAvailable)('the audit row behind a scope approval', () => {
  it('is found for exactly the business, job and fingerprint that were approved, and for nothing else', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Approve Co A');
      const b = await createTenantWithUser(c, 'Approve Co B');
      const job = randomUUID();
      const hash = approvalHash(approvedScope());
      await writeAudit(c, { tenantId: a.tenantId, userId: a.userId, action: 'scope.approve', entity: 'job', entityId: compactId(job), meta: { engine: 'fallback', sections: 1, steps: 2, hash } });
      expect(await auditedApprovalWith(c, a.tenantId, job, hash)).toBe(true);
      expect(await auditedApprovalWith(c, b.tenantId, job, hash)).toBe(false);
      expect(await auditedApprovalWith(c, a.tenantId, randomUUID(), hash)).toBe(false);
      expect(await auditedApprovalWith(c, a.tenantId, job, approvalHash(approvedScope({ note: 'different' })))).toBe(false);
    });
  });
  it('the fingerprint always passes the audit personal-data check (it starts with a letter, so it can never look like a phone number)', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Approve Co C');
      for (let i = 0; i < 200; i++) {
        const hash = approvalHash(approvedScope({ note: `n${i}` }));
        await writeAudit(c, { tenantId: a.tenantId, userId: a.userId, action: 'scope.approve', entity: 'job', entityId: compactId(randomUUID()), meta: { hash } });
      }
    });
  });
});
