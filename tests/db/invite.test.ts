import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inviteUser, parseInviteArgs } from '../../src/db/invite';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

describe('parseInviteArgs', () => {
  it('parses a valid invite', () => {
    expect(parseInviteArgs(['Ben@FJC.example', 'FJC Roofing Ltd', 'owner', 'Ben Cunningham'])).toEqual({
      email: 'ben@fjc.example', tenantName: 'FJC Roofing Ltd', role: 'owner', fullName: 'Ben Cunningham',
    });
  });
  it('rejects bad input', () => {
    expect(() => parseInviteArgs([])).toThrow(/usage/i);
    expect(() => parseInviteArgs(['not-an-email', 'T', 'owner', 'N'])).toThrow(/email/i);
    expect(() => parseInviteArgs(['a@b.co', 'T', 'admin', 'N'])).toThrow(/role/i);
  });
});

describe('parseInviteArgs tenant id', () => {
  it('accepts --tenant-id and rejects a bad one', () => {
    const id = '3f0c2b9e-7a41-4e0d-9c55-0a1b2c3d4e5f';
    expect(parseInviteArgs(['a@b.co', 'T', 'owner', 'N', '--tenant-id', id]).tenantId).toBe(id);
    expect(() => parseInviteArgs(['a@b.co', 'T', 'owner', 'N', '--tenant-id', 'nope'])).toThrow(/uuid/);
  });
});

describe('inviteUser with a stubbed database', () => {
  const args = { email: 'a@b.test', tenantName: 'Same Co', role: 'staff' as const, fullName: 'X' };
  it('refuses when more than one tenant matches and creates nothing', async () => {
    let created = false;
    const admin = { async createUser() { created = true; return { data: { user: null }, error: null }; }, async deleteUser() { return { error: null }; } };
    const db = { query: async () => ({ rows: [{ id: '1' }, { id: '2' }] }) };
    await expect(inviteUser({ admin, db }, args)).rejects.toThrow(/more than one tenant/i);
    expect(created).toBe(false);
  });
  it('deletes the new auth user when the profile insert fails', async () => {
    const deleted: string[] = [];
    const admin = {
      async createUser() { return { data: { user: { id: 'u-1' } }, error: null }; },
      async deleteUser(id: string) { deleted.push(id); return { error: null }; },
    };
    const db = {
      query: async (sql: string) => {
        if (/insert into public\.profiles/.test(sql)) throw new Error('boom');
        return { rows: /from public\.tenants/.test(sql) ? [{ id: 't-1' }] : [] };
      },
    };
    await expect(inviteUser({ admin, db }, args)).rejects.toThrow(/boom.*removed/);
    expect(deleted).toEqual(['u-1']);
  });
  it('says so when the cleanup fails too', async () => {
    const admin = {
      async createUser() { return { data: { user: { id: 'u-2' } }, error: null }; },
      async deleteUser() { return { error: { message: 'nope' } }; },
    };
    const db = { query: async (sql: string) => { if (/insert into public\.profiles/.test(sql)) throw new Error('boom'); return { rows: /from public\.tenants/.test(sql) ? [{ id: 't-1' }] : [] }; } };
    await expect(inviteUser({ admin, db }, args)).rejects.toThrow(/delete user u-2 by hand/);
  });
});

describe.skipIf(!dbAvailable)('inviteUser', () => {
  it('finds the tenant by id and ignores case in the name', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Case Test Co');
      const admin = {
        async createUser(a: { email: string }) {
          const id = randomUUID();
          await c.query(`insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), now())`, [id, a.email]);
          return { data: { user: { id } }, error: null };
        },
        async deleteUser() { return { error: null }; },
      };
      const byName = await inviteUser({ admin, db: c }, { email: 'one@example.test', tenantName: 'case test co', role: 'staff', fullName: 'One' });
      expect(byName.tenantId).toBe(t.tenantId);
      const byId = await inviteUser({ admin, db: c }, { email: 'two@example.test', tenantName: 'ignored', tenantId: t.tenantId, role: 'staff', fullName: 'Two' });
      expect(byId.tenantId).toBe(t.tenantId);
    });
  });

  it('creates the auth user and a profile in the named tenant', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Invite Test Co');
      const newId = randomUUID();
      const admin = {
        async createUser(a: { email: string; email_confirm: boolean }) {
          expect(a.email_confirm).toBe(true);
          await c.query(`insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), now())`, [newId, a.email]);
          return { data: { user: { id: newId } }, error: null };
        },
        async deleteUser() { return { error: null }; },
      };
      const r = await inviteUser({ admin, db: c }, { email: 'new.person@example.test', tenantName: 'Invite Test Co', role: 'staff', fullName: 'New Person' });
      expect(r).toEqual({ userId: newId, tenantId: t.tenantId });
      const p = await c.query(`select role, email, tenant_id from public.profiles where id = $1`, [newId]);
      expect(p.rows[0]).toEqual({ role: 'staff', email: 'new.person@example.test', tenant_id: t.tenantId });
    });
  });

  it('refuses an unknown tenant without creating a user', async () => {
    await withRollback(async (c) => {
      let called = false;
      const admin = { async createUser() { called = true; return { data: { user: null }, error: null }; }, async deleteUser() { return { error: null }; } };
      await expect(inviteUser({ admin, db: c }, { email: 'a@b.test', tenantName: 'No Such Co', role: 'staff', fullName: 'X' })).rejects.toThrow(/tenant/i);
      expect(called).toBe(false);
    });
  });

  it('refuses an email that already has a profile without creating a user', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Invite Test Co');
      const existing = await c.query(`select email from public.profiles where id = $1`, [t.userId]);
      let called = false;
      const admin = { async createUser() { called = true; return { data: { user: null }, error: null }; }, async deleteUser() { return { error: null }; } };
      await expect(inviteUser({ admin, db: c }, { email: existing.rows[0].email, tenantName: 'Invite Test Co', role: 'staff', fullName: 'X' })).rejects.toThrow(/already has a profile/);
      expect(called).toBe(false);
    });
  });

  it('surfaces an auth error', async () => {
    await withRollback(async (c) => {
      await createTenantWithUser(c, 'Invite Test Co');
      const admin = { async createUser() { return { data: { user: null }, error: { message: 'already registered' } }; }, async deleteUser() { return { error: null }; } };
      await expect(inviteUser({ admin, db: c }, { email: 'a@b.test', tenantName: 'Invite Test Co', role: 'staff', fullName: 'X' })).rejects.toThrow(/already registered/);
    });
  });
});
