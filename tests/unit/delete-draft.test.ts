import { describe, expect, it } from 'vitest';
import { deleteDraftWith, mayDeleteDrafts } from '../../src/lib/documents/delete-draft';
import { InMemoryStorage } from '../../src/lib/storage';
import type { Db } from '../../src/security/login-guard';

const T = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const J = '44444444-4444-4444-8444-444444444444';
const V = '55555555-5555-4555-8555-555555555555';
const actor = { tenantId: T, userId: '66666666-6666-4666-8666-666666666666', role: 'owner' };

function fakeDb(result: Record<string, unknown>, events: string[]) {
  return {
    query: async (text: string) => {
      events.push(text.trim().split(/\s+/).slice(0, 2).join(' '));
      if (text.includes('delete_draft_document')) return { rows: [{ r: result }] };
      return { rows: [] };
    },
  } as unknown as Db;
}

describe('deleteDraftWith', () => {
  it('only owner and staff may delete, before anything is asked of the database', async () => {
    expect(mayDeleteDrafts('owner') && mayDeleteDrafts('staff')).toBe(true);
    expect(mayDeleteDrafts('tradespro_admin')).toBe(false);
    const events: string[] = [];
    expect((await deleteDraftWith(fakeDb({}, events), new InMemoryStorage(), { ...actor, role: 'tradespro_admin' }, D)).status).toBe('not_allowed');
    expect(events).toEqual([]);
  });
  it('rolls back and changes nothing when the database refuses', async () => {
    for (const status of ['issued', 'in_use', 'not_found']) {
      const events: string[] = [];
      const s = new InMemoryStorage();
      expect((await deleteDraftWith(fakeDb({ status }, events), s, actor, D)).status).toBe(status);
      expect(events).toContain('rollback');
      expect(events.some((e) => e.startsWith('insert into'))).toBe(false);
      expect(s.deletedPrefixes).toEqual([]);
    }
  });
  it('audits, commits, and only then removes the draft\'s own files; a storage failure never undoes the delete', async () => {
    const events: string[] = [];
    const s = new InMemoryStorage();
    await s.put(`${T}/${C}/${J}/${V}/preview-k/page-01.png`, Buffer.from('x'), 'image/png');
    const r = await deleteDraftWith(fakeDb({ status: 'deleted', customerId: C, jobId: J, jobDeleted: false, versionIds: [V], photoPaths: [] }, events), s, actor, D);
    expect(r.status).toBe('deleted');
    expect(events.indexOf('commit')).toBeGreaterThan(events.findIndex((e) => e.startsWith('insert into')));
    expect(s.deletedPrefixes).toEqual([`${T}/${C}/${J}/${V}/`]);
    const s2 = new InMemoryStorage();
    s2.failNext = true;
    expect((await deleteDraftWith(fakeDb({ status: 'deleted', customerId: C, jobId: J, jobDeleted: true, versionIds: [V], photoPaths: [`${T}/${C}/${J}/p.jpg`, 'other-tenant/x.jpg'] }, []), s2, actor, D)).status).toBe('deleted');
  });
  it('never touches files outside this business', async () => {
    const s = new InMemoryStorage();
    const r = await deleteDraftWith(fakeDb({ status: 'deleted', customerId: C, jobId: J, jobDeleted: false, versionIds: [], photoPaths: ['99999999-9999-4999-8999-999999999999/a/b/c.jpg'] }, []), s, actor, D);
    expect(r.removed?.paths).toEqual([]);
  });
});
