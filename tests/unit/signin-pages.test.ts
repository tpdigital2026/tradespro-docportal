import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/session', () => ({ getSession: async () => null }));
// A database with no business at all: every slug lookup returns no row.
vi.mock('../../src/lib/data/customer-admin', () => ({
  withServiceConnection: async (fn: (db: { query: () => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => fn({ query: async () => ({ rows: [] }) }),
}));

import BrandedLogin from '../../src/app/[slug]/page';
import LoginPreview from '../../src/app/dev/login/page';
import LoginPage from '../../src/app/login/page';
import { SignIn } from '../../src/components/SignIn';
import { DEMO_BRAND, TRADESPRO_BRAND, type TenantBrand } from '../../src/lib/brand-core';

const signin = (brand: TenantBrand) => renderToStaticMarkup(createElement(SignIn, { brand, children: createElement('div') }));
const html = async (el: Promise<React.ReactElement>) => renderToStaticMarkup(await el);
const branded = (slug: string) => html(BrandedLogin({ params: Promise.resolve({ slug }) }) as Promise<React.ReactElement>);

afterEach(() => vi.unstubAllEnvs());

describe('sign-in pages', () => {
  it('an unknown slug, a reserved word and a malformed slug render exactly the plain /login markup', async () => {
    const plain = await html(LoginPage({ searchParams: Promise.resolve({}) }) as Promise<React.ReactElement>);
    for (const slug of ['no-such-biz', 'customers', 'dev', 'x', 'Bad_Slug']) expect(await branded(slug), slug).toBe(plain);
  });
  it('says why after the session policy signed someone out, and only then', async () => {
    const out = await html(LoginPage({ searchParams: Promise.resolve({ notice: 'signed-out' }) }) as Promise<React.ReactElement>);
    expect(out).toContain('You were signed out for your security. Sign in again to carry on.');
    const plain = await html(LoginPage({ searchParams: Promise.resolve({ notice: 'other' }) }) as Promise<React.ReactElement>);
    expect(plain).not.toContain('signed out');
  });
  it('the plain sign-in carries no business letterhead and no FJC brand', async () => {
    const plain = await branded('no-such-biz');
    expect(plain).not.toContain('login-sample.png');
    expect(plain).not.toContain('/brands/fjc');
    expect(plain).toContain('Illustration of a document page');
    expect(plain).toContain('Quotes, invoices, receipts and guarantees, ready to send.');
  });
  it('the sign-in photo comes from the brand data, not the address; nobody shows the old letterhead sample', () => {
    const fjc = signin(DEMO_BRAND);
    expect(fjc).toContain('/brands/fjc/van-1600.jpg');
    expect(fjc).toContain('alt="FJC Roofing van"');
    expect(fjc).not.toContain('Illustration of a document page');
    const other = signin({ ...DEMO_BRAND, slug: 'other', name: 'Other Ltd', signInPhoto: null });
    expect(other).not.toContain('/brands/fjc/van');
    // Same slug as FJC but no photo on record: no photo. Another slug with a photo on record: its photo.
    expect(signin({ ...DEMO_BRAND, signInPhoto: null })).not.toContain('/brands/fjc/van');
    const own = signin({ ...DEMO_BRAND, slug: 'acme', name: 'Acme Ltd', signInPhoto: { src: '/brands/acme/yard-1200.jpg', width: 1200, height: 800, srcSetJpg: '/brands/acme/yard-1200.jpg 1200w', srcSetWebp: null, alt: 'Acme yard' } });
    expect(own).toContain('/brands/acme/yard-1200.jpg');
    expect(own).toContain('alt="Acme yard"');
    expect(other).toContain('Illustration of a document page');
    expect(signin(TRADESPRO_BRAND)).not.toContain('/brands/fjc/van');
    for (const html of [fjc, other, signin(TRADESPRO_BRAND)]) expect(html).not.toContain('login-sample.png');
  });
  it('access is invite only and says nothing about it; the wide hero band sits in the FJC brand panel only', () => {
    for (const html of [signin(DEMO_BRAND), signin(TRADESPRO_BRAND)]) {
      expect(html).not.toMatch(/Not invited|by invitation/i);
    }
    expect(signin(DEMO_BRAND)).toContain('/brands/fjc/hero-wide-1400.jpg');
    expect(signin({ ...DEMO_BRAND, isOwnBrand: true })).not.toContain('signin-foot');
    expect(signin(TRADESPRO_BRAND)).not.toContain('hero-wide');
  });
  it('the illustration holds no text at all', () => {
    const plain = signin(TRADESPRO_BRAND);
    const svg = /<svg class="sheet"[\s\S]*?<\/svg>/.exec(plain)![0];
    expect(svg.replace(/<[^>]*>/g, '')).toBe('');
  });
});

describe('/dev/login', () => {
  it('is a 404 outside demo mode', async () => {
    vi.stubEnv('DEMO_MODE', '');
    await expect(LoginPreview({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });
  it('is a 404 in production and on Vercel even with DEMO_MODE=1', async () => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(LoginPreview({ searchParams: Promise.resolve({}) })).rejects.toBeTruthy();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VERCEL', '1');
    await expect(LoginPreview({ searchParams: Promise.resolve({}) })).rejects.toBeTruthy();
  });
  it('renders in demo mode', async () => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('VERCEL', '');
    const out = renderToStaticMarkup((await LoginPreview({ searchParams: Promise.resolve({ state: 'code' }) })) as React.ReactElement);
    expect(out).toContain('Enter your code');
  });
});
