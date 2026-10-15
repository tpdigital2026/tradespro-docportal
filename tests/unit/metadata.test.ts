import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/session', () => ({ getSession: async () => null, requireSession: async () => ({}) }));
vi.mock('../../src/lib/data/customer-admin', () => ({
  withServiceConnection: async (fn: (db: { query: () => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => fn({ query: async () => ({ rows: [] }) }),
}));

import nextConfig, { ROBOTS_HEADER } from '../../next.config';
import { metadata as rootMetadata, viewport } from '../../src/app/layout';
import robots from '../../src/app/robots';
import { generateMetadata as slugMetadata } from '../../src/app/[slug]/page';
import { metadata as loginMetadata } from '../../src/app/login/page';
import { generateMetadata as newDocMetadata } from '../../src/app/(app)/documents/new/page';
import { generateMetadata as jobMetadata } from '../../src/app/(app)/documents/jobs/[quote]/page';
import { DEMO_BRAND, TRADESPRO_BRAND } from '../../src/lib/brand-core';
import { shareCardFor, signInMetadata, siteUrl, THEME_NAVY, THEME_PAPER } from '../../src/lib/site';

const ROOT = path.join(__dirname, '../..');
const APP = path.join(ROOT, 'src/app');
const PUBLIC = path.join(ROOT, 'public');
const sharp = createRequire(path.join(ROOT, 'package.json'))('sharp') as (p: string) => { metadata(): Promise<{ width?: number; height?: number }> };

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return pages(p);
    return name === 'page.tsx' ? [p] : [];
  });
}
const size = async (publicUrl: string) => sharp(path.join(PUBLIC, publicUrl)).metadata();

describe('titles', () => {
  it('the root layout has a title template and a default', () => {
    expect(rootMetadata.title).toEqual({ default: 'TradesPro DocPortal', template: '%s | TradesPro DocPortal' });
    expect(rootMetadata.metadataBase?.toString()).toBe('https://docs.tradesprodigital.io/');
  });
  it('every page sets its own title and description (static or generated)', () => {
    const all = pages(APP);
    expect(all.length).toBeGreaterThan(8);
    for (const p of all) {
      const src = readFileSync(p, 'utf8');
      expect(/export const metadata\b|export async function generateMetadata\b/.test(src), path.relative(ROOT, p)).toBe(true);
    }
  });
  it('the not-found page has its own title', () => {
    for (const f of ['not-found.tsx', '(app)/not-found.tsx']) expect(readFileSync(path.join(APP, f), 'utf8'), f).toContain("title: 'Page not found'");
  });
  it('documents and jobs get titles from what they are', async () => {
    const t = async (sp: Record<string, string>) => (await newDocMetadata({ searchParams: Promise.resolve(sp) })).title;
    expect(await t({})).toBe('New document');
    expect(await t({ type: 'quotation' })).toBe('New quotation');
    expect(await t({ type: 'deposit-invoice' })).toBe('New deposit invoice');
    expect(await t({ type: 'nonsense' })).toBe('New document');
    expect((await jobMetadata({ params: Promise.resolve({ quote: 'FJC1001' }) })).title).toBe('Job FJC1001');
  });
});

describe('sign-in metadata', () => {
  it('the plain sign-in, an unknown address and a reserved word share exactly the same metadata', async () => {
    const plain = loginMetadata;
    for (const slug of ['no-such-biz', 'customers', 'Bad_Slug']) expect(await slugMetadata({ params: Promise.resolve({ slug }) })).toEqual(plain);
    expect(plain.title).toEqual({ absolute: 'Sign in | TradesPro DocPortal' });
  });
  it('a business address uses the business name and only FJC gets the FJC card', () => {
    const fjc = signInMetadata(DEMO_BRAND);
    expect(fjc.title).toEqual({ absolute: 'Sign in | FJC Roofing Ltd' });
    expect(shareCardFor(DEMO_BRAND).url).toBe('/brands/fjc/og.jpg');
    expect(shareCardFor({ ...DEMO_BRAND, slug: 'other', name: 'Other Ltd' }).url).toBe('/og/docportal.png');
    expect(shareCardFor(TRADESPRO_BRAND).url).toBe('/og/docportal.png');
  });
  it('share text says nothing about anyone', () => {
    const s = JSON.stringify([signInMetadata(TRADESPRO_BRAND), signInMetadata(DEMO_BRAND), rootMetadata]);
    expect(s).not.toMatch(/@|\b\d{5,}\b/);
  });
});

describe('never indexed', () => {
  it('the root layout says noindex, nofollow, noarchive, and no page overrides robots', () => {
    expect(rootMetadata.robots).toMatchObject({ index: false, follow: false, noarchive: true });
    const files = [...pages(APP), path.join(APP, 'not-found.tsx'), path.join(APP, '(app)/not-found.tsx')];
    for (const p of files) expect(readFileSync(p, 'utf8'), path.relative(ROOT, p)).not.toMatch(/robots\s*:|index:\s*true/);
  });
  it('every route sends X-Robots-Tag', async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === '/:path*');
    expect(all?.headers).toContainEqual(ROBOTS_HEADER);
    expect(ROBOTS_HEADER.value).toMatch(/noindex/);
    expect(ROBOTS_HEADER.value).toMatch(/nofollow/);
  });
  it('robots.txt disallows everything and names no sitemap', () => {
    const r = robots();
    expect(r.rules).toEqual([{ userAgent: '*', disallow: '/' }]);
    expect(r.sitemap).toBeUndefined();
    expect(existsSync(path.join(APP, 'sitemap.ts'))).toBe(false);
  });
});

describe('icons, manifest and share cards', () => {
  it('every icon in the metadata exists at the size it claims', async () => {
    const icons = rootMetadata.icons as { icon: { url: string; sizes: string }[]; apple: { url: string; sizes: string }[] };
    expect(existsSync(path.join(APP, 'favicon.ico'))).toBe(true);
    for (const i of [...icons.icon, ...icons.apple]) {
      if (i.url === '/favicon.ico') continue;
      const [w, h] = i.sizes.split('x').map(Number);
      expect(await size(i.url), i.url).toMatchObject({ width: w, height: h });
    }
  });
  it('the manifest is complete, its colours come from the tokens and its icons are the right size', async () => {
    const m = JSON.parse(readFileSync(path.join(PUBLIC, 'site.webmanifest'), 'utf8'));
    expect(rootMetadata.manifest).toBe('/site.webmanifest');
    expect(m).toMatchObject({ name: 'TradesPro DocPortal', short_name: 'DocPortal', start_url: '/', display: 'standalone', theme_color: THEME_NAVY, background_color: THEME_NAVY });
    const tokens = readFileSync(path.join(ROOT, 'src/styles/tokens.css'), 'utf8');
    expect(tokens).toContain(`--navy-900: ${THEME_NAVY};`);
    expect(tokens).toContain(`--paper: ${THEME_PAPER};`);
    for (const i of m.icons) {
      const [w, h] = String(i.sizes).split('x').map(Number);
      expect(await size(i.src), i.src).toMatchObject({ width: w, height: h });
    }
    expect(m.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  });
  it('the theme colour is navy in light and dark', () => {
    expect(viewport.themeColor).toEqual([
      { media: '(prefers-color-scheme: light)', color: THEME_NAVY },
      { media: '(prefers-color-scheme: dark)', color: THEME_NAVY },
    ]);
  });
  it('og:image files exist and are 1200 by 630', async () => {
    for (const card of [shareCardFor(TRADESPRO_BRAND), shareCardFor(DEMO_BRAND)]) {
      expect(await size(card.url), card.url).toMatchObject({ width: 1200, height: 630 });
    }
  });
});

describe('siteUrl', () => {
  it('comes from the environment, https only, with a safe default', () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: 'https://preview.example.com' }).host).toBe('preview.example.com');
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: 'http://evil.example.com' }).host).toBe('docs.tradesprodigital.io');
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: 'not a url' }).host).toBe('docs.tradesprodigital.io');
    expect(siteUrl({}).host).toBe('docs.tradesprodigital.io');
  });
});
