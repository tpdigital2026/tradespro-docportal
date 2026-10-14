import { describe, expect, it, vi } from 'vitest';
import {
  hashEmail,
  recentAttempts,
  recentIpFailures,
  recentIpRequests,
  recordAttempt,
  requestCodeWithGuard,
  verifyWithGuard,
} from '../../src/security/login-guard';
import { dbAvailable, withRollback } from './helpers';

const P = 'test-pepper-0123456789-0123456789';

describe.skipIf(!dbAvailable)('login attempt storage', () => {
  it('records attempts and reads back only recent ones for that email', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('ben@example.com', P);
      const other = hashEmail('someone@example.com', P);
      await recordAttempt(c, { emailHash: h, ip: '203.0.113.5', kind: 'verify', success: false });
      await recordAttempt(c, { emailHash: h, ip: '203.0.113.5', kind: 'request', success: true });
      await recordAttempt(c, { emailHash: other, ip: '203.0.113.9', kind: 'verify', success: false });
      await c.query(`insert into public.login_attempts (email_hash, ip, kind, success, at) values ($1, '203.0.113.5', 'verify', false, now() - interval '2 hours')`, [h]);
      const rows = await recentAttempts(c, h, new Date());
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.at instanceof Date)).toBe(true);
    });
  });

  it('counts failures per IP across emails', async () => {
    await withRollback(async (c) => {
      for (let i = 0; i < 3; i++) {
        await recordAttempt(c, { emailHash: hashEmail(`u${i}@example.com`, P), ip: '198.51.100.7', kind: 'verify', success: false });
      }
      await recordAttempt(c, { emailHash: hashEmail('ok@example.com', P), ip: '198.51.100.7', kind: 'verify', success: true });
      expect(await recentIpFailures(c, '198.51.100.7', new Date())).toBe(3);
      // A missing IP shares one sentinel bucket that live sign-ins also write to, so compare with what is already there.
      const base = await recentIpFailures(c, null as any, new Date());
      await recordAttempt(c, { emailHash: hashEmail('n@example.com', P), ip: null as any, kind: 'verify', success: false });
      expect(await recentIpFailures(c, null as any, new Date())).toBe(base + 1);
    });
  });

  it('counts code requests per IP across emails, ignoring verifies', async () => {
    await withRollback(async (c) => {
      for (let i = 0; i < 4; i++) {
        await recordAttempt(c, { emailHash: hashEmail(`r${i}@example.com`, P), ip: '198.51.100.8', kind: 'request', success: true });
      }
      await recordAttempt(c, { emailHash: hashEmail('v@example.com', P), ip: '198.51.100.8', kind: 'verify', success: false });
      expect(await recentIpRequests(c, '198.51.100.8', new Date())).toBe(4);
      const base = await recentIpRequests(c, null as any, new Date());
      await recordAttempt(c, { emailHash: hashEmail('n2@example.com', P), ip: null as any, kind: 'request', success: true });
      expect(await recentIpRequests(c, undefined as any, new Date())).toBe(base + 1);
    });
  });

  it('stores a hash only, and refuses anything that is not a 64 character hex hash', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('ben@example.com', P);
      await recordAttempt(c, { emailHash: h, ip: '192.0.2.1', kind: 'request', success: true });
      const r = await c.query(`select email_hash from public.login_attempts where email_hash = $1`, [h]);
      expect(r.rows[0].email_hash).toMatch(/^[0-9a-f]{64}$/);
      await expect(recordAttempt(c, { emailHash: 'ben@example.com', ip: '192.0.2.1', kind: 'request', success: true })).rejects.toThrow();
    });
  });
});

describe.skipIf(!dbAvailable)('guarded verification', () => {
  const run = (c: any, h: string, checkCode: () => Promise<boolean>, ip = '192.0.2.10') =>
    verifyWithGuard(c, { emailHash: h, ip, checkCode, callerOwnsTransaction: true });

  it('verifies a correct code and records a success', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('guard1@example.com', P);
      const spy = vi.fn(async () => true);
      expect(await run(c, h, spy)).toEqual({ outcome: 'verified' });
      expect(spy).toHaveBeenCalledOnce();
      const rows = await recentAttempts(c, h, new Date());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'verify', success: true });
    });
  });

  it('records a wrong code and returns wrong_code', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('guard2@example.com', P);
      expect(await run(c, h, async () => false)).toEqual({ outcome: 'wrong_code' });
      expect((await recentAttempts(c, h, new Date()))[0]).toMatchObject({ kind: 'verify', success: false });
    });
  });

  it('blocks the sixth attempt after five wrong codes without calling checkCode, even for the right code', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('guard3@example.com', P);
      for (let i = 0; i < 5; i++) expect((await run(c, h, async () => false)).outcome).toBe('wrong_code');
      const spy = vi.fn(async () => true);
      const r = await run(c, h, spy);
      expect(r.outcome).toBe('blocked');
      expect(r).toMatchObject({ decision: { allowed: false, reason: 'locked' } });
      expect(spy).not.toHaveBeenCalled();
      expect(await recentAttempts(c, h, new Date())).toHaveLength(5);
    });
  });

  it('an unknown email behaves identically to a known one', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('nobody-here@example.com', P);
      for (let i = 0; i < 5; i++) expect(await run(c, h, async () => false, '192.0.2.11')).toEqual({ outcome: 'wrong_code' });
      expect((await run(c, h, async () => false, '192.0.2.11')).outcome).toBe('blocked');
    });
  });
});

describe.skipIf(!dbAvailable)('guarded code requests', () => {
  it('allows five requests per email, then blocks without recording', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('guard4@example.com', P);
      for (let i = 0; i < 5; i++) {
        expect(await requestCodeWithGuard(c, { emailHash: h, ip: '192.0.2.20', callerOwnsTransaction: true })).toEqual({ outcome: 'allowed' });
      }
      const r = await requestCodeWithGuard(c, { emailHash: h, ip: '192.0.2.20', callerOwnsTransaction: true });
      expect(r).toMatchObject({ outcome: 'blocked', decision: { reason: 'too_many_codes' } });
      expect(await recentAttempts(c, h, new Date())).toHaveLength(5);
    });
  });

  it('blocks an address after 30 requests across emails', async () => {
    await withRollback(async (c) => {
      for (let i = 0; i < 30; i++) {
        await recordAttempt(c, { emailHash: hashEmail(`many${i}@example.com`, P), ip: '192.0.2.30', kind: 'request', success: true });
      }
      const r = await requestCodeWithGuard(c, { emailHash: hashEmail('fresh@example.com', P), ip: '192.0.2.30', callerOwnsTransaction: true });
      expect(r).toMatchObject({ outcome: 'blocked', decision: { reason: 'ip_blocked' } });
    });
  });
});
