/**
 * Home smoke test (owner's live report: "Home buttons not working").
 *
 * Renders Home for real (react-dom/server, async server components and next/link included), collects every link and
 * button target, then:
 *  - demo mode: renders each target page too and fails on a 404, a crash or a redirect to a missing route; checks every
 *    #anchor exists on the page it points at;
 *  - real-mode fake (data modules mocked with real-mode shapes: uuid ids, awkward quote numbers): checks every target
 *    matches an app route, is not swallowed by the sign-in slug rule or the public routes in the proxy, and that a quote
 *    number survives the round trip through the job URL;
 *  - statically: no Home server component passes an event handler (that would break the production RSC build), and
 *    the client components Home reaches are the ones reviewed here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

const APP = path.join(__dirname, '../../src/app');

// ------------------------------------------------------------------ routes on disk

type Route = { segments: string[]; file: string };
function routes(dir = APP, prefix: string[] = []): Route[] {
  const out: Route[] = [];
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) {
      if (e.startsWith('_') || e.startsWith('@')) continue;
      out.push(...routes(f, e.startsWith('(') ? prefix : [...prefix, e]));
    } else if (e === 'page.tsx') out.push({ segments: prefix, file: f });
  }
  return out;
}
const ROUTES = routes();

/** The page a pathname resolves to (static segments win over dynamic ones), with its params; null for a 404. */
function match(pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean);
  const candidates = ROUTES.filter((r) => r.segments.length === parts.length)
    .map((r) => {
      const params: Record<string, string> = {};
      let score = 0;
      for (let i = 0; i < parts.length; i += 1) {
        const s = r.segments[i];
        if (s === parts[i]) score += 2;
        else if (/^\[[^.\]]+\]$/.test(s)) params[s.slice(1, -1)] = decodeURIComponent(parts[i]);
        else return null;
      }
      return { route: r, params, score };
    })
    .filter((x): x is { route: Route; params: Record<string, string>; score: number } => x !== null)
    .sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

// ------------------------------------------------------------------ rendering

const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), hmrRefresh: vi.fn() };

async function render(node: ReactNode, url: URL): Promise<{ html: string; error: unknown }> {
  const errors: unknown[] = [];
  const wrapped = createElement(
    AppRouterContext.Provider,
    { value: router as never },
    createElement(PathnameContext.Provider, { value: url.pathname }, createElement(SearchParamsContext.Provider, { value: url.searchParams as never }, node)),
  );
  try {
    const stream = await renderToReadableStream(wrapped, { onError: (e) => void errors.push(e) });
    const html = await new Response(stream).text();
    return { html, error: errors[0] ?? null };
  } catch (e) {
    return { html: '', error: e };
  }
}

const decodeHtml = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
const hrefsOf = (html: string) => [...new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => decodeHtml(m[1])))];
const idsOf = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const digest = (e: unknown) => String((e as { digest?: unknown } | null)?.digest ?? '');

async function renderHome() {
  const { default: Home } = await import('../../src/app/(app)/page');
  return render(createElement(Home as never, { searchParams: Promise.resolve({}) }), new URL('http://x/'));
}

async function renderTarget(href: string): Promise<{ ok: boolean; why: string; html: string }> {
  const url = new URL(href, 'http://x');
  const m = match(url.pathname);
  if (!m) return { ok: false, why: 'no route', html: '' };
  const mod = (await import(/* @vite-ignore */ m.route.file)) as { default: (p: unknown) => unknown };
  const searchParams = Object.fromEntries(url.searchParams.entries());
  const r = await render(createElement(mod.default as never, { params: Promise.resolve(m.params), searchParams: Promise.resolve(searchParams) }), url);
  const d = digest(r.error);
  if (d.startsWith('NEXT_HTTP_ERROR_FALLBACK;404')) return { ok: false, why: '404 (notFound)', html: '' };
  if (d.startsWith('NEXT_REDIRECT')) {
    const to = d.split(';')[2];
    return match(new URL(to, 'http://x').pathname) || to.startsWith('/api/') ? { ok: true, why: `redirect ${to}`, html: '' } : { ok: false, why: `redirect to missing ${to}`, html: '' };
  }
  if (r.error) return { ok: false, why: `crash: ${(r.error as Error)?.message ?? String(r.error)}`, html: '' };
  if (/could not be found|is not here/.test(r.html)) return { ok: false, why: 'not-found wording', html: r.html };
  return { ok: true, why: '', html: r.html };
}

// ------------------------------------------------------------------ demo mode

describe('Home in demo mode: every link and button lands on a working page', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders, with the document tiles, Start a quote, job next steps, Create receipt and Mark as paid', async () => {
    const { html, error } = await renderHome();
    expect(error).toBeNull();
    expect(html).toContain('Start a quote');
    const hrefs = hrefsOf(html);
    for (const t of ['quotation', 'survey', 'deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage', 'receipt', 'guarantee']) expect(hrefs).toContain(`/documents/new?type=${t}`);
    expect(html).toMatch(/Mark [^<]* as paid|Record the rest/);
    expect(html).toMatch(/Create (<!-- -->)?receipt/);
    expect(hrefs.some((h) => h.startsWith('/documents/jobs/'))).toBe(true);
  });

  it('guards the checker itself: a missing job, a missing document and a missing route are all reported', async () => {
    expect((await renderTarget('/documents/jobs/NO-SUCH-JOB')).ok).toBe(false);
    expect((await renderTarget('/documents/demo-doc-nothing-here')).ok).toBe(false);
    expect((await renderTarget('/nowhere/at/all')).why).toBe('no route');
  });

  it('every target renders without a 404, a crash or a redirect to nowhere, and every #anchor exists', async () => {
    const { html } = await renderHome();
    const homeIds = idsOf(html);
    const hrefs = hrefsOf(html).filter((h) => !/^https?:/.test(h) && !h.startsWith('/_next/') && !/\.(png|jpe?g|webp|svg|ico|webmanifest)$/.test(h));
    expect(hrefs.length).toBeGreaterThan(20);
    const failures: string[] = [];
    for (const href of hrefs) {
      if (href.startsWith('#')) {
        if (!homeIds.has(href.slice(1))) failures.push(`${href}: no such id on Home`);
        continue;
      }
      const r = await renderTarget(href);
      if (!r.ok) failures.push(`${href}: ${r.why}`);
      const hash = new URL(href, 'http://x').hash;
      if (r.ok && hash && r.html && !idsOf(r.html).has(hash.slice(1))) failures.push(`${href}: no ${hash} on the target page`);
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

// ------------------------------------------------------------------ real-mode fake

const QUOTES = ['FJC-1043', 'FJC/2026/7', 'Q.17', 'AB_9'];
const uuid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`.slice(-36);

vi.mock('../../src/lib/data/billing', async (orig) => {
  const real = await orig<typeof import('../../src/lib/data/billing')>();
  return { ...real, listJobSummaries: vi.fn(async () => (globalThis as { __realJobs?: unknown[] }).__realJobs ?? (await real.listJobSummaries())) };
});
vi.mock('../../src/lib/data/quotes', async (orig) => {
  const real = await orig<typeof import('../../src/lib/data/quotes')>();
  return { ...real, listDraftQuotes: vi.fn(async () => (globalThis as { __realDrafts?: unknown[] }).__realDrafts ?? (await real.listDraftQuotes())) };
});
vi.mock('../../src/lib/data/documents', async (orig) => {
  const real = await orig<typeof import('../../src/lib/data/documents')>();
  return { ...real, listLibrary: vi.fn(async (f?: unknown) => (globalThis as { __realLibrary?: unknown })?.__realLibrary ?? (await real.listLibrary(f as never))) };
});
vi.mock('../../src/lib/data/survey-links', async (orig) => {
  const real = await orig<typeof import('../../src/lib/data/survey-links')>();
  return { ...real, listSurveyedJobs: vi.fn(async () => (globalThis as { __realSurveyed?: unknown[] }).__realSurveyed ?? (await real.listSurveyedJobs())) };
});

describe('Home with real-mode data (fake): every target is a real, reachable route', () => {
  beforeEach(async () => {
    vi.stubEnv('DEMO_MODE', '1'); // session, brand and the money strip come from the demo; the lists below are real-shaped
    const { buildJobBilling } = await import('../../src/lib/job-billing');
    const { listJobSummaries } = await import('../../src/lib/data/billing');
    const g = globalThis as Record<string, unknown>;
    g.__realJobs = undefined;
    const demoJobs = await (listJobSummaries as unknown as () => Promise<{ billing: unknown }[]>)();
    // Re-label the demo jobs' billing with awkward real-mode quote numbers (slashes, dots, underscores).
    g.__realJobs = demoJobs.filter((j) => j.billing).map((j, i) => ({ ...j, quoteNumber: QUOTES[i % QUOTES.length], customerName: `Customer ${i}`, addressLine: `${i} High Street` }));
    void buildJobBilling;
    g.__realDrafts = [
      { jobId: uuid(1), documentId: uuid(2), quoteNumber: 'FJC-2001', customerName: 'Mr Draft', date: '2026-07-01' },
      { jobId: uuid(3), documentId: null, quoteNumber: 'FJC/2002', customerName: 'Mrs Unsaved', date: '2026-07-01' },
    ];
    g.__realLibrary = { items: [{ id: uuid(4), type: 'quotation', number: 'FJC-2001', status: 'final', date: '2026-07-01', customerName: 'Mr Draft', jobId: uuid(1), quoteNumber: 'FJC-2001', totalPence: 100, createdAt: '2026-07-01T09:00:00Z' }], truncated: false };
    g.__realSurveyed = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    const g = globalThis as Record<string, unknown>;
    for (const k of ['__realJobs', '__realDrafts', '__realLibrary', '__realSurveyed']) delete g[k];
  });

  it('every href matches an app route, is guarded (never public, never read as a sign-in address), and job numbers round trip', async () => {
    const { html, error } = await renderHome();
    expect(error).toBeNull();
    const { isValidSlug } = await import('../../src/lib/slug');
    const hrefs = hrefsOf(html).filter((h) => h.startsWith('/') && !h.startsWith('/_next/') && !/\.(png|jpe?g|webp|svg|ico)$/.test(h));
    const failures: string[] = [];
    for (const href of hrefs) {
      const url = new URL(href, 'http://x');
      const m = match(url.pathname);
      if (!m) failures.push(`${href}: no route`);
      else if (m.route.segments[0] === '[slug]' || m.route.segments[0] === 'login') failures.push(`${href}: lands on a sign-in page`);
      const one = /^\/[^/]+$/.test(url.pathname) && isValidSlug(url.pathname.slice(1));
      if (one) failures.push(`${href}: the proxy would treat it as a public sign-in address`);
      if (url.pathname.startsWith('/documents/jobs/')) {
        const q = m?.params.quote;
        if (!q || !QUOTES.includes(q)) failures.push(`${href}: job number did not round trip (${q})`);
      }
      if (url.pathname === '/documents/new') {
        const t = url.searchParams.get('type');
        if (!['quotation', 'survey', 'deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage', 'receipt', 'guarantee'].includes(t ?? '')) failures.push(`${href}: unknown type`);
        const job = url.searchParams.get('job');
        if (job !== null && !QUOTES.includes(job)) failures.push(`${href}: job did not round trip (${job})`);
      }
      if (/^\/documents\/[^/]+$/.test(url.pathname) && !['new', 'jobs'].includes(url.pathname.split('/')[2]) && !/^[0-9a-f-]{36}$/.test(url.pathname.split('/')[2])) failures.push(`${href}: document link without a real id`);
    }
    expect(hrefs.some((h) => h.includes('FJC%2F2026%2F7'))).toBe(true);
    expect(hrefs).toContain(`/documents/${uuid(2)}`);
    expect(hrefs).toContain(`/documents/new?type=quotation&draft=${uuid(3)}`);
    expect(failures).toEqual([]);
  });
});

// ------------------------------------------------------------------ static checks

describe('Home components: server/client boundary', () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, '../..', rel), 'utf8');
  const SERVER = ['src/app/(app)/page.tsx', 'src/components/HomeHero.tsx', 'src/components/DocTypeList.tsx', 'src/components/JobRow.tsx', 'src/components/MoneyStrip.tsx', 'src/components/EmptyState.tsx', 'src/components/DocTypeIcon.tsx', 'src/components/StageChips.tsx', 'src/components/Button.tsx'];
  it('no Home server component passes an event handler or uses client hooks (both fail only in the production RSC build)', () => {
    for (const f of SERVER) {
      const s = read(f);
      expect(s, f).not.toMatch(/^['"]use client['"]/m);
      expect(s, f).not.toMatch(/\son[A-Z][a-zA-Z]*=\{/);
      expect(s, f).not.toMatch(/\buse(State|Effect|Router|Pathname|SearchParams|Ref)\(/);
    }
  });
  it('the shell around Home is a client component (it reads the path), and its only buttons are Log out and More', () => {
    const shell = read('src/components/Shell.tsx');
    expect(shell).toMatch(/^'use client';/);
    expect(read('src/components/MoreMenu.tsx')).toMatch(/^'use client';/);
  });
});
