import { afterEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (jar.values.has(n) ? { value: jar.values.get(n) } : undefined) }) }));
const claims = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/lib/supabase-server', () => ({
  anonClient: () => ({ auth: { getClaims: async () => ((claims.calls += 1), { data: null, error: new Error('no') }) } }),
}));

import { POST } from '../../src/app/api/demo/step-up/route';
import { DEMO_STEP_UP_CODE, demoStepUpCookieName, demoStepUpFresh, issueDemoStepUp } from '../../src/lib/step-up-demo';
import { requireFreshStepUpForRequest, StepUpRequiredError } from '../../src/lib/step-up-check';

const ORIGIN = 'https://app.example.test';
const demoOn = () => {
  vi.stubEnv('DEMO_MODE', '1');
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('VERCEL', '');
};
const post = (body: unknown) => new Request(`${ORIGIN}/api/demo/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });

afterEach(() => {
  vi.unstubAllEnvs();
  jar.values.clear();
  claims.calls = 0;
});

describe('demo step-up stand-in', () => {
  it('is refused outright outside demo mode: no cookie is issued or accepted, and the route is a 404', async () => {
    vi.stubEnv('DEMO_MODE', '');
    expect(() => issueDemoStepUp(1_800_000_000)).toThrow();
    expect((await POST(post({ action: 'request' }))).status).toBe(404);
    expect((await POST(post({ action: 'verify', code: DEMO_STEP_UP_CODE }))).status).toBe(404);
    demoOn();
    const value = issueDemoStepUp(1_800_000_000);
    vi.stubEnv('DEMO_MODE', '');
    expect(demoStepUpFresh(value, 1_800_000_000)).toBe(false);
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('VERCEL', '1');
    expect(demoStepUpFresh(value, 1_800_000_000)).toBe(false);
  });

  it('a cookie it signed is fresh for 10 minutes; a forged or stale one is not', () => {
    demoOn();
    const now = 1_800_000_000;
    const value = issueDemoStepUp(now);
    expect(demoStepUpFresh(value, now + 600)).toBe(true);
    expect(demoStepUpFresh(value, now + 601)).toBe(false);
    expect(demoStepUpFresh(`${now}.${'A'.repeat(43)}`, now)).toBe(false);
    expect(demoStepUpFresh(value.replace(/^\d+/, String(now + 100)), now + 100)).toBe(false);
    expect(demoStepUpFresh(undefined, now)).toBe(false);
  });

  it('the route says which dummy code to use, and sets the cookie only for that code', async () => {
    demoOn();
    const asked = await POST(post({ action: 'request' }));
    expect((await asked.json()).message).toBe(`Demo mode: no email is sent. Use the code ${DEMO_STEP_UP_CODE}.`);
    const wrong = await POST(post({ action: 'verify', code: '22222222' }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.getSetCookie()).toHaveLength(0);
    const right = await POST(post({ action: 'verify', code: DEMO_STEP_UP_CODE }));
    expect(right.status).toBe(200);
    expect(right.headers.getSetCookie()[0]).toMatch(new RegExp(`^${demoStepUpCookieName()}=`));
    const cross = new Request(`${ORIGIN}/api/demo/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: '{"action":"request"}' });
    expect((await POST(cross)).status).toBe(403);
  });

  it('requireFreshStepUpForRequest: demo needs the demo cookie; real mode never reads it and asks Supabase', async () => {
    demoOn();
    await expect(requireFreshStepUpForRequest()).rejects.toBeInstanceOf(StepUpRequiredError);
    jar.values.set(demoStepUpCookieName(), issueDemoStepUp(Math.floor(Date.now() / 1000)));
    await expect(requireFreshStepUpForRequest()).resolves.toBeUndefined();
    expect(claims.calls).toBe(0);
    vi.stubEnv('DEMO_MODE', '');
    await expect(requireFreshStepUpForRequest()).rejects.toBeInstanceOf(StepUpRequiredError);
  });
});
