import { describe, expect, it } from 'vitest';
import { hashEmail, recentAttempts, recentIpFailures, recordAttempt } from '../../src/security/login-guard';
import { dbAvailable, withRollback } from './helpers';

describe.skipIf(!dbAvailable)('login attempt storage', () => {
  it('records attempts and reads back only recent ones for that email', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('ben@example.com', 'pepper');
      const other = hashEmail('someone@example.com', 'pepper');
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
        await recordAttempt(c, { emailHash: hashEmail(`u${i}@example.com`, 'p'), ip: '198.51.100.7', kind: 'verify', success: false });
      }
      await recordAttempt(c, { emailHash: hashEmail('ok@example.com', 'p'), ip: '198.51.100.7', kind: 'verify', success: true });
      expect(await recentIpFailures(c, '198.51.100.7', new Date())).toBe(3);
      expect(await recentIpFailures(c, null, new Date())).toBe(0);
    });
  });

  it('stores only a hash, never the email', async () => {
    await withRollback(async (c) => {
      const h = hashEmail('ben@example.com', 'pepper');
      await recordAttempt(c, { emailHash: h, ip: null, kind: 'request', success: true });
      const r = await c.query(`select email_hash from public.login_attempts where email_hash = $1`, [h]);
      expect(r.rows[0].email_hash).not.toContain('ben');
    });
  });
});
