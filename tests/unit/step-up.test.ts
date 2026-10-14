import { describe, expect, it } from 'vitest';
import { STEP_UP_MAX_AGE_SECONDS, StepUpRequiredError, assertRecentStepUp } from '../../src/security/step-up';

const now = 1_800_000_000;

describe('assertRecentStepUp', () => {
  it('passes with a fresh otp sign-in', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'otp', timestamp: now - 60 }] }, now)).not.toThrow();
  });
  it('passes at the edge of the window', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'otp', timestamp: now - STEP_UP_MAX_AGE_SECONDS }] }, now)).not.toThrow();
  });
  it('rejects an old sign-in', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'otp', timestamp: now - STEP_UP_MAX_AGE_SECONDS - 1 }] }, now)).toThrow(StepUpRequiredError);
  });
  it('rejects missing or empty amr', () => {
    expect(() => assertRecentStepUp({}, now)).toThrow(StepUpRequiredError);
    expect(() => assertRecentStepUp({ amr: [] }, now)).toThrow(StepUpRequiredError);
  });
  it('rejects methods that are not an emailed code', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'password', timestamp: now }] }, now)).toThrow(StepUpRequiredError);
  });
  it('uses the most recent matching entry', () => {
    const amr = [{ method: 'otp', timestamp: now - 100_000 }, { method: 'otp', timestamp: now - 30 }];
    expect(() => assertRecentStepUp({ amr }, now)).not.toThrow();
  });
  it('rejects timestamps in the future beyond clock skew', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'otp', timestamp: now + 3600 }] }, now)).toThrow(StepUpRequiredError);
    expect(() => assertRecentStepUp({ amr: [{ method: 'otp', timestamp: now + 30 }] }, now)).not.toThrow();
  });
  it('has a friendly message and name', () => {
    expect.assertions(2);
    try {
      assertRecentStepUp({}, now);
    } catch (e) {
      expect((e as Error).name).toBe('StepUpRequiredError');
      expect((e as Error).message).toMatch(/fresh email code/i);
    }
  });
  it('never throws anything but StepUpRequiredError, whatever the claims look like', () => {
    const bad: unknown[] = [
      null,
      undefined,
      { amr: { method: 'otp', timestamp: now } },
      { amr: 'otp' },
      { amr: [null, 1, 'x'] },
      { amr: [{ method: 5, timestamp: now }] },
      { amr: [{ method: 'otp', timestamp: String(now) }] },
      { amr: [{ method: 'otp', timestamp: Number.NaN }] },
      { amr: [{ method: 'email', timestamp: now }] },
    ];
    for (const claims of bad) {
      expect(() => assertRecentStepUp(claims as never, now), JSON.stringify(claims)).toThrow(StepUpRequiredError);
    }
  });
  it('accepts magiclink', () => {
    expect(() => assertRecentStepUp({ amr: [{ method: 'magiclink', timestamp: now - 5 }] }, now)).not.toThrow();
  });
  it('skips junk entries before a valid one', () => {
    expect(() => assertRecentStepUp({ amr: [null, 1, { method: 'otp', timestamp: now }] as never }, now)).not.toThrow();
  });
  it('ignores entries after the first 20', () => {
    const amr = Array.from({ length: 20 }, () => ({ method: 'password', timestamp: now }));
    amr.push({ method: 'otp', timestamp: now });
    expect(() => assertRecentStepUp({ amr }, now)).toThrow(StepUpRequiredError);
  });
});
