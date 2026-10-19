import { afterEach, describe, expect, it, vi } from 'vitest';
import { attempt, describeError, logFailure } from '../../src/lib/log-failure';

afterEach(() => vi.restoreAllMocks());

describe('logFailure', () => {
  it('writes the stage, the class and the code, and nothing else', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error('duplicate key for Mrs Jane Doe, 12 High Street, 4500 pounds'), { code: '23505', detail: 'Key (email)=(jane@example.com)', stack: 'at secret/path' });
    logFailure('home.jobs', err);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toBe('[failure] stage=home.jobs class=Error code=23505');
    for (const leak of ['Jane', 'High Street', '4500', 'jane@example.com', 'secret/path', 'duplicate']) expect(line).not.toContain(leak);
  });

  it('keeps no message from odd values and strips unsafe characters from the stage and class', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logFailure('a b\nc=<x>', 'Mrs Doe lives at 1 Road');
    logFailure('x', { name: 'Bad Name\n[evil]', code: 'a code with spaces and an address 1 Road' });
    logFailure('x', null);
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toBe('[failure] stage=abcx class=string code=-');
    expect(lines[1]).toBe('[failure] stage=x class=BadNameevil code=-');
    expect(lines[2]).toBe('[failure] stage=x class=- code=-');
    for (const l of lines) expect(l).not.toMatch(/Doe|Road|\n/);
  });

  it('describes a numeric code and a subclass name', () => {
    class PoolError extends Error {
      name = 'PoolError';
    }
    expect(describeError(Object.assign(new PoolError('x'), { code: 57014 }))).toEqual({ cls: 'PoolError', code: '57014' });
  });
});

describe('attempt', () => {
  it('returns the value when the load works and logs nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(attempt('s', async () => [1, 2], [])).resolves.toEqual({ value: [1, 2], failed: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns the fallback, flags the failure and logs one safe line when the load throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await attempt<string[]>('home.library', async () => Promise.reject(new TypeError('private wording here')), []);
    expect(r).toEqual({ value: [], failed: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe('[failure] stage=home.library class=TypeError code=-');
  });
});
