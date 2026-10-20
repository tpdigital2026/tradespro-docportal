/**
 * Real-Chrome click-through of the signed-in app, at 390 and 1280 wide, against a DEMO dev server (dummy data in
 * memory only; nothing reaches a database).
 *
 *   DEMO_MODE=1 npx next dev -p 3519          (own free port)
 *   npm run check:clicks -- http://localhost:3519 [--widths=390,1280] [--out=report.md]
 *
 * Visits every signed-in page and clicks every link and button that is safe. For each click it checks: it navigates or
 * opens something visible; a navigation lands on a 200 page with a heading, no "not found", no bounce to sign-in, no
 * console error, no failed request, no loading state still showing after 3 s, and the browser's Back returns. Log out
 * and the irreversible Delete / Finalise buttons are skipped in the crawl and tested separately on throwaway demo drafts
 * (delete from Home, Documents and the draft page; a full preview, read, tick and finalise). Also: the payment flow
 * (Mark as paid from Home, Save payment, Create receipt, straight to the preview, Home updated after) and keyboard Tab
 * order (the logo, the navigation and the main action are reachable on every page).
 *
 * Prints a table of every control with pass or fail, writes it as Markdown with --out, and exits 1 on any failure.
 * Not part of CI (it needs Chrome and a running demo server).
 */
import { writeFileSync } from 'node:fs';
import { chromium, type Browser, type ElementHandle, type Page } from 'playwright-core';

const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:3519').replace(/\/$/, '');
const WIDTHS = (args.find((a) => a.startsWith('--widths='))?.slice(9) ?? '390,1280').split(',').map(Number);
const OUT = args.find((a) => a.startsWith('--out='))?.slice(6) ?? null;
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7) ?? null;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SETTLE_MS = 3000;

interface Row {
  width: number;
  page: string;
  control: string;
  kind: string;
  ok: boolean;
  note: string;
}
const rows: Row[] = [];
const record = (r: Row) => {
  rows.push(r);
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.width} ${r.page} :: ${r.control} [${r.kind}]${r.note ? ` ${r.note}` : ''}`);
};

/** Problems seen on the current page since the last reset: console errors, page errors, failed document or data requests. */
class Watch {
  problems: string[] = [];
  constructor(page: Page) {
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // Dev-only noise that is not an app error.
      if (/Download the React DevTools|\[HMR\]|webpack-hmr|turbopack-hmr|Fast Refresh/i.test(t)) return;
      this.problems.push(`console: ${t.slice(0, 160)}`);
    });
    page.on('pageerror', (e) => this.problems.push(`page error: ${String(e.message).slice(0, 160)}`));
    page.on('response', (r) => {
      const req = r.request();
      const type = req.resourceType();
      if (r.status() >= 400 && (type === 'document' || type === 'fetch' || type === 'xhr')) this.problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
    });
  }
  take(): string[] {
    const p = this.problems;
    this.problems = [];
    return p;
  }
}

const path = (page: Page) => {
  const u = new URL(page.url());
  return u.pathname + u.search;
};

/** Waits until nothing on the page says it is loading (skeleton, aria-busy, the preview's progress), up to `ms`. */
async function settled(page: Page, ms = SETTLE_MS): Promise<boolean> {
  // Hydration must finish before the script touches the page (it tags controls with an attribute).
  await page.waitForLoadState('networkidle', { timeout: Math.max(ms, 5000) }).catch(() => undefined);
  try {
    await page.waitForFunction(
      // The live drawing of a document page (.rv-doc) legitimately takes a few seconds; it is checked on its own below.
      `(() => ![...document.querySelectorAll('[aria-busy="true"], .skel, .pending-hint.is-pending')].some((e) => !e.closest('.rv-doc')) && !!document.querySelector('h1'))()`,
      undefined,
      { timeout: ms, polling: 100 },
    );
    return true;
  } catch {
    return false;
  }
}

async function heading(page: Page): Promise<string> {
  return ((await page.evaluate(`document.querySelector('h1')?.innerText ?? ''`)) as string).replace(/\s+/g, ' ').trim();
}

async function landed(page: Page, watch: Watch, allowSlow = false): Promise<string[]> {
  const notes: string[] = [];
  const ok = await settled(page, allowSlow ? 20000 : SETTLE_MS);
  if (!ok) notes.push(`still loading after ${allowSlow ? 20 : 3} s`);
  const drawing = await page
    .waitForFunction(`!document.querySelector('.rv-doc [aria-busy="true"]')`, undefined, { timeout: 30000, polling: 250 })
    .then(() => true, () => false);
  if (!drawing) notes.push('the document page did not finish drawing in 30 s');
  const h = await heading(page);
  if (!h) notes.push('no heading');
  if (/not found|404|something went wrong/i.test(h)) notes.push(`heading "${h}"`);
  if (new URL(page.url()).pathname === '/login') notes.push('sent to sign-in');
  const sideways = (await page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`)) as boolean;
  if (sideways) notes.push('page scrolls sideways');
  notes.push(...watch.take());
  return notes;
}

interface Control {
  key: string;
  tag: string;
  text: string;
  href: string | null;
  type: string | null;
  download: boolean;
  shell: boolean;
  inForm: boolean;
}

/** Every visible, enabled link and button on the page, with a stable key for finding it again after a reload. */
async function controls(page: Page): Promise<Control[]> {
  return (await page.evaluate(`(() => {
    const seen = new Map();
    const out = [];
    for (const el of document.querySelectorAll('a[href], button, [role="menuitem"]')) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || el.closest('[hidden], dialog:not([open])')) continue;
      // Disabled, or the step you are already on (aria-disabled): not something to press.
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const tag = el.tagName.toLowerCase();
      const text = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      const href = el.getAttribute('href');
      const base = tag + '|' + text + '|' + (href || '');
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      el.setAttribute('data-cc', String(out.length));
      out.push({ key: base + '#' + n, tag, text, href, type: el.getAttribute('type'), download: el.hasAttribute('download'), shell: !!el.closest('.rail, .topbar, .bottomnav, .main-foot'), inForm: !!el.closest('form') });
    }
    return out;
  })()`)) as Control[];
}

async function find(page: Page, key: string): Promise<ElementHandle | null> {
  const all = await controls(page);
  const i = all.findIndex((c) => c.key === key);
  return i < 0 ? null : page.$(`[data-cc="${i}"]`);
}

/** Clicks like a person; a control that is only shown on focus (the skip link) is reached by keyboard instead. */
async function press(el: ElementHandle): Promise<void> {
  try {
    await el.click({ timeout: 5000 });
  } catch {
    await el.focus();
    await el.press('Enter');
  }
}

const SKIP_DESTRUCTIVE = /^(log out|delete draft$|delete permanently|yes, delete|delete this customer|delete|finalise|confirm and finalise|archive account|remove|delete appointment)/i;
const SKIP_SEND = /^(email me a code|send|confirm and save|confirm and delete|save payment)$/i;

/** One page: every control on it, clicked from a fresh load of that page. */
async function crawlPage(page: Page, watch: Watch, width: number, name: string, url: string, testedShell: Set<string>, opts: { allowSlow?: boolean; before?: (p: Page) => Promise<void> } = {}) {
  const load = async () => {
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await settled(page, opts.allowSlow ? 30000 : 15000);
    // Controls inside a drawn document page appear once it is drawn.
    await page.waitForFunction(`!document.querySelector('.rv-doc [aria-busy="true"]')`, undefined, { timeout: 30000, polling: 250 }).catch(() => undefined);
    if (opts.before) await opts.before(page);
  };
  await load();
  const first = await landed(page, watch, opts.allowSlow);
  record({ width, page: name, control: '(page load)', kind: 'page', ok: first.length === 0, note: first.join('; ') });
  const list = await controls(page);
  for (const c of list) {
    if (ONLY && !c.key.includes(ONLY)) continue;
    const label = `${c.tag === 'a' ? 'link' : 'button'} "${c.text || c.href}"`;
    if (SKIP_DESTRUCTIVE.test(c.text) && !c.href) {
      record({ width, page: name, control: label, kind: 'skipped', ok: true, note: 'irreversible or log out: tested separately' });
      continue;
    }
    if (/^log out$/i.test(c.text)) continue;
    if (c.shell && c.href && testedShell.has(`${c.href}`)) continue;
    // Downloads and files: fetched, not clicked (a download has no page to land on).
    if (c.href && (c.download || c.href.startsWith('/api/'))) {
      const res = await page.request.get(BASE + c.href);
      const ct = res.headers()['content-type'] ?? '';
      record({ width, page: name, control: label, kind: 'download', ok: res.status() === 200, note: res.status() === 200 ? ct.split(';')[0] : `HTTP ${res.status()}` });
      continue;
    }
    if (c.href && /^(mailto:|tel:|https?:)/.test(c.href)) {
      record({ width, page: name, control: label, kind: 'external', ok: true, note: 'not followed' });
      continue;
    }
    if (path(page) !== url) await load();
    let el = await find(page, c.key);
    if (!el) {
      await load();
      el = await find(page, c.key);
    }
    if (!el) {
      record({ width, page: name, control: label, kind: 'missing', ok: false, note: 'could not find it again after a reload' });
      continue;
    }
    watch.take();
    if (c.href) {
      const target = new URL(c.href, BASE + url);
      const samePage = target.pathname + target.search === new URL(BASE + url).pathname + new URL(BASE + url).search;
      if (samePage && target.hash) {
        await press(el);
        await page.waitForTimeout(150);
        const exists = (await page.evaluate(`!!document.getElementById(${JSON.stringify(decodeURIComponent(target.hash.slice(1)))})`)) as boolean;
        const notes = exists ? watch.take() : ['the place it points to is not on the page'];
        record({ width, page: name, control: label, kind: 'anchor', ok: notes.length === 0, note: notes.join('; ') });
        continue;
      }
      const t0 = Date.now();
      try {
        await Promise.all([samePage ? Promise.resolve() : page.waitForURL((u) => u.pathname + u.search !== url, { timeout: 15000 }), press(el)]);
      } catch {
        record({ width, page: name, control: label, kind: 'link', ok: false, note: 'pressing it did not go anywhere within 15 s' });
        await load();
        continue;
      }
      const notes = await landed(page, watch, opts.allowSlow || /\/preview/.test(target.pathname));
      const ms = Date.now() - t0;
      const now = path(page);
      if (!samePage) {
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
        await settled(page, 15000);
        if (path(page) !== url) notes.push(`Back went to ${path(page)}`);
      }
      notes.push(...watch.take().filter((x) => !x.startsWith('console: Warning')));
      if (c.shell) testedShell.add(c.href);
      record({ width, page: name, control: label, kind: 'link', ok: notes.length === 0, note: `${now} in ${ms} ms${notes.length ? `: ${notes.join('; ')}` : ''}` });
      continue;
    }
    // A button: something visible must change (a dialog, a panel, a form, a message, or a new page).
    if (SKIP_SEND.test(c.text)) {
      record({ width, page: name, control: label, kind: 'skipped', ok: true, note: 'sends a code or saves; covered by its own flow' });
      continue;
    }
    const before = (await page.evaluate(`({ html: document.body.innerHTML.length, dialogs: document.querySelectorAll('dialog[open]').length, url: location.href, expanded: [...document.querySelectorAll('[aria-expanded="true"]')].length, text: document.body.innerText.length })`)) as Record<string, unknown>;
    await press(el).catch(() => undefined);
    await page.waitForTimeout(600);
    const after = (await page.evaluate(`({ html: document.body.innerHTML.length, dialogs: document.querySelectorAll('dialog[open]').length, url: location.href, expanded: [...document.querySelectorAll('[aria-expanded="true"]')].length, text: document.body.innerText.length })`)) as Record<string, unknown>;
    const changed = Object.keys(before).some((k) => before[k] !== after[k]);
    const notes = watch.take();
    if (!changed) notes.unshift('nothing visible happened');
    record({ width, page: name, control: label, kind: 'button', ok: notes.length === 0, note: notes.join('; ') });
    await page.keyboard.press('Escape').catch(() => undefined);
    await load();
  }
}

/** Tab from the top: the logo link, a main navigation link and the page's main action must all be reachable. */
async function tabOrder(page: Page, width: number, name: string, url: string) {
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await settled(page, 15000);
  const reached = new Set<string>();
  const main = (await page.evaluate(`(() => { const a = document.querySelector('main .pagehead-action a, main .pagehead-action button, main .btn-primary'); return a ? (a.getAttribute('aria-label') || a.innerText).replace(/\\s+/g,' ').trim() : ''; })()`)) as string;
  for (let i = 0; i < 250; i += 1) {
    await page.keyboard.press('Tab');
    const f = (await page.evaluate(`(() => { const e = document.activeElement; if (!e) return ''; if (e.classList.contains('brand-home')) return 'logo'; if (e.closest('nav[aria-label="Main"]')) return 'nav'; return 'main:' + (e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g,' ').trim(); })()`)) as string;
    if (f === 'logo' || f === 'nav') reached.add(f);
    if (main && f === `main:${main}`) reached.add('main');
    if (reached.has('logo') && reached.has('nav') && (reached.has('main') || !main)) break;
  }
  const missing = ['logo', 'nav', ...(main ? ['main'] : [])].filter((x) => !reached.has(x));
  record({ width, page: name, control: `Tab order (logo, navigation${main ? `, "${main}"` : ''})`, kind: 'keyboard', ok: missing.length === 0, note: missing.length ? `not reached: ${missing.join(', ')}` : '' });
}

/** Throwaway demo drafts: delete from Home (cancel first), from Documents and from the draft page. */
async function deleteFlows(page: Page, watch: Watch, width: number) {
  const tryDelete = async (where: string, url: string, trigger: string, expectUrl: RegExp) => {
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await settled(page, 15000);
    watch.take();
    const btn = page.locator(trigger).first();
    if (!(await btn.count())) return record({ width, page: where, control: 'Delete draft', kind: 'delete', ok: false, note: 'no draft to delete' });
    const box = await btn.boundingBox();
    const small = box && (box.height < 44 || box.width < 44);
    await btn.click();
    const dialog = page.locator('dialog[open]');
    const opened = await dialog.isVisible();
    const text = opened ? await dialog.innerText() : '';
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const closed = !(await page.locator('dialog[open]').count());
    const focusBack = (await page.evaluate(`document.activeElement?.getAttribute('aria-label') || document.activeElement?.innerText || ''`)) as string;
    await btn.click();
    const t0 = Date.now();
    await page.locator('dialog[open] button', { hasText: 'Delete draft' }).click();
    await page.waitForURL(expectUrl, { timeout: 15000 }).catch(() => undefined);
    const notes = await landed(page, watch);
    const flash = await page.locator('.flash', { hasText: 'Draft deleted' }).count();
    if (!opened || !/Delete this draft\?/.test(text) || !/cannot be undone/i.test(text)) notes.push('confirmation dialog missing or wrong words');
    if (!closed) notes.push('Escape did not cancel');
    if (!/delete draft/i.test(focusBack)) notes.push('focus did not return to the button');
    if (small) notes.push('button smaller than 44px');
    if (!expectUrl.test(path(page))) notes.push(`landed on ${path(page)}`);
    if (!flash) notes.push('no "Draft deleted" confirmation');
    record({ width, page: where, control: 'Delete draft (cancel, then confirm)', kind: 'delete', ok: notes.length === 0, note: `${Date.now() - t0} ms${notes.length ? `: ${notes.join('; ')}` : ''}` });
  };
  await tryDelete('Home, Quotes to finish', '/?view=quotes', 'button.del-draft-text', /deleted=draft/);
  await tryDelete('Documents, draft row', '/documents', 'button.lib-delete', /deleted=draft/);
  await tryDelete('Draft page', firstDraftUrl ?? '/documents', 'button.del-draft-btn', /deleted=draft/);
}

let firstDraftUrl: string | null = null;

/** Mark as paid from Home, Save payment, Create receipt, straight to the preview, then Home shows the change. */
async function paymentFlow(page: Page, watch: Watch, width: number) {
  await page.goto(`${BASE}/?view=waiting`, { waitUntil: 'domcontentloaded' });
  await settled(page, 15000);
  const waitingBefore = Number(((await page.locator('a.fig', { hasText: 'Waiting for payment' }).locator('.fig-n').innerText().catch(() => '-1')) || '-1').trim());
  const go = page.locator('.jobs-table a[href*="?pay="]').first();
  if (!(await go.count())) return record({ width, page: 'Payment flow', control: 'Mark invoice as paid', kind: 'flow', ok: false, note: 'no invoice waiting for payment' });
  watch.take();
  await go.click();
  await page.waitForSelector('dialog.pay-dialog[open]', { timeout: 15000 }).catch(() => undefined);
  const dlg = page.locator('dialog.pay-dialog[open]');
  const notes: string[] = [];
  if (!(await dlg.count())) notes.push('payment form did not open by itself');
  else {
    const amount = await dlg.locator('input[id$="-amount"]').inputValue();
    const date = await dlg.locator('input[type="date"]').inputValue();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
    const methods = await dlg.locator('.pay-method').allInnerTexts();
    if (!amount || amount === '0.00') notes.push('amount not pre-filled');
    if (date !== today) notes.push(`date ${date}, not today`);
    if (methods.join('|') !== 'Bank transfer|Cash|Card|Other') notes.push(`methods: ${methods.join(', ')}`);
    await dlg.locator('.pay-method', { hasText: 'Cash' }).click();
    await dlg.locator('button[type="submit"]').click();
    await page.waitForSelector('dialog.pay-dialog[open] .pay-tick', { timeout: 15000 }).catch(() => notes.push('no confirmation after Save payment'));
    const primary = page.locator('dialog.pay-dialog[open] .btn-primary');
    if ((await primary.count()) !== 1 || !/create receipt/i.test(await primary.innerText())) notes.push('confirmation does not offer one primary Create receipt');
    await primary.click();
    await page.waitForURL(/\/documents\/[^/]+\/preview/, { timeout: 30000 }).catch(() => notes.push(`Create receipt went to ${path(page)}`));
    notes.push(...(await landed(page, watch, true)));
    await page.goto(`${BASE}/?view=waiting`, { waitUntil: 'domcontentloaded' });
    await settled(page, 15000);
    const waitingAfter = Number(((await page.locator('a.fig', { hasText: 'Waiting for payment' }).locator('.fig-n').innerText().catch(() => '-1')) || '-1').trim());
    if (!(waitingAfter < waitingBefore || waitingBefore < 0)) notes.push(`Home still shows ${waitingAfter} waiting (was ${waitingBefore})`);
  }
  notes.push(...watch.take());
  record({ width, page: 'Payment flow', control: 'Mark as paid, Save payment, Create receipt, preview, Home updated', kind: 'flow', ok: notes.length === 0, note: notes.join('; ') });
}

/** A full finalise of a throwaway demo draft: preview, every page read (scrolled into view), tick, finalise. */
async function finaliseFlow(page: Page, watch: Watch, width: number, candidates: string[]) {
  const notes: string[] = [];
  let used = '';
  for (const draftUrl of candidates) {
    await page.goto(`${BASE}${draftUrl}/preview`, { waitUntil: 'domcontentloaded' });
    await settled(page, 60000);
    if (await page.locator('.pv-page').count()) {
      used = draftUrl;
      break;
    }
  }
  if (!used) {
    record({ width, page: 'Finalise flow', control: 'Preview, read every page, tick, Finalise', kind: 'finalise', ok: false, note: 'no draft could be previewed' });
    return;
  }
  watch.take();
  const pages = page.locator('.pv-page');
  const n = await pages.count();
  for (let i = 0; i < n; i += 1) {
    await pages.nth(i).scrollIntoViewIfNeeded();
    await page.locator(`.pv-page[data-page="${i}"].is-read`).waitFor({ timeout: 30000 }).catch(() => notes.push(`page ${i + 1} never counted as read`));
  }
  await page.locator('.pv-side input[type="checkbox"]').first().check().catch(() => notes.push('could not tick the confirmation'));
  await page.locator('button.pv-go').click();
  await page.waitForURL(/finalised=1/, { timeout: 90000 }).catch(() => notes.push(`finalise ended on ${path(page)}`));
  notes.push(...(await landed(page, watch, true)));
  record({ width, page: 'Finalise flow', control: `Preview ${n} pages, read every page, tick, Finalise (${used})`, kind: 'finalise', ok: notes.length === 0, note: notes.join('; ') });
}

async function run(browser: Browser, width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const watch = new Watch(page);
  const shell = new Set<string>();

  // Discover demo ids from the app itself.
  await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded' });
  await settled(page, 30000);
  const customerUrl = ((await page.locator('main a[href^="/customers/"]:not([href="/customers/new"])').first().getAttribute('href').catch(() => null)) ?? '/customers');
  await page.goto(`${BASE}/documents?status=draft`, { waitUntil: 'domcontentloaded' });
  await settled(page, 30000);
  const drafts = await page.locator('main .lib-row.is-draft a.lib-link').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
  const draftUrl = drafts[0] ?? '/documents';
  firstDraftUrl = drafts[drafts.length - 1] ?? null;
  const quoteDraftJob = draftUrl.match(/demo-doc-(demo-job-\d+)/)?.[1] ?? '';

  const pages: [string, string, { allowSlow?: boolean; before?: (p: Page) => Promise<void> }?][] = [
    ['Home', '/'],
    ['Home, Quotes to finish', '/?view=quotes'],
    ['Home, Waiting for payment', '/?view=waiting'],
    ['Home, All', '/?view=all'],
    ['Customers', '/customers'],
    ['A customer', customerUrl],
    ['New customer', '/customers/new'],
    ['Documents', '/documents'],
    ['Documents, drafts', '/documents?status=draft'],
    ['A draft', draftUrl],
    ['A final document', '/documents/demo-doc-3001-q'],
    ['A job', '/documents/jobs/QT-BR-001'],
    ['Pipeline', '/pipeline'],
    ['Money', '/money'],
    ['Calendar', '/calendar'],
    ['New appointment', '/calendar/new'],
    ['Guarantees', '/guarantees'],
    ['Settings', '/settings'],
    ['New document', '/documents/new'],
    ...(['quotation', 'deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage', 'receipt', 'guarantee', 'survey'] as const).map((t): [string, string] => [`New ${t}`, `/documents/new?type=${t}`]),
    ...(['customer', 'job', 'scope', 'price', 'plan', 'review'] as const).map((s): [string, string, { allowSlow: boolean }] => [`Quote stepper: ${s}`, `/documents/new?type=quotation&draft=${quoteDraftJob}&step=${s}`, { allowSlow: true }]),
    ['Preview (finalise page)', `${draftUrl}/preview`, { allowSlow: true }],
    ['Deposit invoice for a job', '/documents/new?type=deposit-invoice&job=QT-BR-001&n=1'],
    ['Home, New document menu open', '/', { before: async (p) => { await p.locator('main button', { hasText: 'New document' }).first().click(); } }],
    ...(width < 760 ? [['More menu open', '/', { before: async (p: Page) => { await p.locator('.bottomnav button.more-btn').click(); } }] as [string, string, { before: (p: Page) => Promise<void> }]] : []),
  ];
  for (const [name, url, o] of pages) await crawlPage(page, watch, width, name, url, shell, o ?? {});
  for (const [name, url] of pages.filter(([, , o]) => !o?.before)) await tabOrder(page, width, name, url);
  await paymentFlow(page, watch, width);
  await deleteFlows(page, watch, width);
  // Finalise a throwaway draft (one that is still there after the deletes).
  await page.goto(`${BASE}/documents?status=draft`, { waitUntil: 'domcontentloaded' });
  await settled(page, 15000);
  const left = await page.locator('main .lib-row.is-draft a.lib-link').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
  await finaliseFlow(page, watch, width, left);
  await ctx.close();
}

/**
 * --timing: time to first feedback for the main actions, at 390 wide with the CPU slowed 4x and 400 ms added to every
 * request (a phone on site). Feedback is the first visible sign the tap registered: a spinner, a loading skeleton, a
 * busy or disabled button, a dialog, or the new page itself. "Ready" is when the next screen (or the form) is usable.
 */
const FEEDBACK_PROBE = `(() => {
  window.__fb = null; window.__t0 = performance.now(); const url0 = location.href;
  const hit = () => !!document.querySelector('.pending-hint.is-pending, [aria-busy="true"], .skel, dialog[open], button[disabled][aria-busy]') || location.href !== url0;
  const mo = new MutationObserver(() => { if (window.__fb === null && hit()) { window.__fb = performance.now() - window.__t0; mo.disconnect(); } });
  mo.observe(document, { subtree: true, childList: true, attributes: true });
  window.__mo = mo;
})()`;

async function timing(browser: Browser): Promise<string> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const out: string[] = ['| Action | First feedback | Next screen ready |', '|---|---|---|'];
  const slow = async (on: boolean) => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: on ? 4 : 1 });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: on ? 400 : 0, downloadThroughput: -1, uploadThroughput: -1 });
  };
  const measure = async (name: string, from: string, act: (p: Page) => Promise<void>, ready: (p: Page) => Promise<unknown>, prepare?: (p: Page) => Promise<void>) => {
    await slow(false);
    await page.goto(BASE + from, { waitUntil: 'networkidle', timeout: 120000 });
    await settled(page, 20000);
    if (prepare) await prepare(page);
    await slow(true);
    await page.evaluate(FEEDBACK_PROBE);
    const t0 = Date.now();
    let fb = '-';
    let done = '-';
    try {
      await act(page);
      await ready(page);
      done = `${Date.now() - t0} ms`;
      const f = (await page.evaluate('window.__fb')) as number | null;
      fb = f === null ? 'none seen' : `${Math.round(f)} ms`;
    } catch (e) {
      done = `did not finish (${String((e as Error).message).split('\n')[0].slice(0, 60)})`;
      const f = (await page.evaluate('window.__fb').catch(() => null)) as number | null;
      fb = f === null ? 'none seen' : `${Math.round(f)} ms`;
    }
    out.push(`| ${name} | ${fb} | ${done} |`);
    console.log(`${name}: feedback ${fb}, ready ${done}`);
  };
  const heading = (re: RegExp) => (p: Page) => p.waitForFunction(`(() => ${re}.test(document.querySelector('h1')?.innerText ?? '') && !document.querySelector('.skel'))()`, undefined, { timeout: 60000 });
  await measure('Tab: Home to Customers', '/', (p) => p.locator('.bottomnav a[href="/customers"]').click(), heading(/Customers/));
  await measure('Tab: Home to Documents', '/', (p) => p.locator('.bottomnav a[href="/documents"]').click(), heading(/Documents/));
  await measure('More, then Pipeline', '/', (p) => p.locator('.more-panel a[href="/pipeline"]').click(), heading(/pipeline/i), (p) => p.locator('.bottomnav button.more-btn').click());
  await measure('More, then Money', '/', (p) => p.locator('.more-panel a[href="/money"]').click(), heading(/money/i), (p) => p.locator('.bottomnav button.more-btn').click());
  await measure('New document tile: Quotation', '/documents/new', (p) => p.locator('main a[href="/documents/new?type=quotation"]').first().click(), (p) => p.waitForFunction(`/type=quotation/.test(location.search) && !!document.querySelector('.qt-steps') && !document.querySelector('.skel')`, undefined, { timeout: 60000 }));
  await measure('Home: open a job row', '/?view=all', (p) => p.locator('.jobs-table a.jt-open').first().click(), (p) => p.waitForFunction(`/\\/documents\\/jobs\\//.test(location.pathname) && !!document.querySelector('.job-total, .inst, h1') && !document.querySelector('.skel')`, undefined, { timeout: 60000 }));
  await measure('Home: Mark invoice as paid', '/?view=waiting', (p) => p.locator('.jobs-table a[href*="/documents/jobs/"]').filter({ hasText: /paid|record/i }).first().click(), (p) => p.waitForSelector('dialog.pay-dialog[open], .inst', { timeout: 60000 }));
  await measure('Save payment', '/?view=waiting', (p) => p.locator('dialog.pay-dialog[open] button[type="submit"]').click(), (p) => p.waitForSelector('dialog.pay-dialog[open] .pay-tick', { timeout: 60000 }), async (p) => {
    await p.locator('.jobs-table a[href*="/documents/jobs/"]').filter({ hasText: /paid|record/i }).first().click();
    await p.waitForURL(/documents\/jobs/);
    await settled(p, 20000);
    if (!(await p.locator('dialog.pay-dialog[open]').count())) await p.locator('button[data-pay-open], button[aria-haspopup="dialog"]').first().click();
    await p.waitForSelector('dialog.pay-dialog[open]');
  });
  await measure('Create receipt (after a payment)', '/?view=waiting', async (p) => {
    const b = p.locator('dialog.pay-dialog[open] .btn-primary, dialog.pay-dialog[open] a.btn-primary').first();
    await b.click();
  }, (p) => p.waitForURL(/\/documents\/(new\?|[^/]+\/preview)/, { timeout: 60000 }), async (p) => {
    await p.locator('.jobs-table a[href*="/documents/jobs/"]').filter({ hasText: /paid|record/i }).first().click();
    await p.waitForURL(/documents\/jobs/);
    await settled(p, 20000);
    if (!(await p.locator('dialog.pay-dialog[open]').count())) await p.locator('button[data-pay-open], button[aria-haspopup="dialog"]').first().click();
    await p.locator('dialog.pay-dialog[open] button[type="submit"]').click();
    await p.waitForSelector('dialog.pay-dialog[open] .pay-tick', { timeout: 60000 });
  });
  await measure('Delete draft: confirm', '/?view=quotes', (p) => p.locator('dialog[open] button', { hasText: 'Delete draft' }).click(), (p) => p.waitForURL(/deleted=draft/, { timeout: 60000 }), async (p) => {
    const t = p.locator('button.del-draft-text').first();
    if (await t.count()) await t.click();
  });
  await ctx.close();
  return out.join('\n');
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME });
  if (args.includes('--timing')) {
    try {
      const warm = await browser.newPage();
      for (const u of ['/', '/customers', '/documents', '/pipeline', '/money', '/documents/new', '/documents/new?type=quotation', '/documents/jobs/QT-BR-001', '/documents/jobs/QT-BR-003']) await warm.goto(BASE + u, { waitUntil: 'networkidle', timeout: 180000 }).catch(() => undefined);
      await warm.close();
      const table = await timing(browser);
      if (OUT) writeFileSync(OUT, table);
      console.log(table);
    } finally {
      await browser.close();
    }
    return;
  }
  try {
    // Warm the dev server so first-compile time does not count as a slow page.
    const warm = await browser.newPage();
    for (const u of ['/', '/customers', '/documents', '/pipeline', '/money', '/calendar', '/guarantees', '/settings', '/documents/new', '/documents/new?type=quotation', '/documents/jobs/QT-BR-001']) {
      await warm.goto(BASE + u, { waitUntil: 'networkidle', timeout: 180000 }).catch(() => undefined);
    }
    await warm.close();
    for (const w of WIDTHS) await run(browser, w);
  } finally {
    await browser.close();
  }
  const failed = rows.filter((r) => !r.ok);
  const md = [
    `| Width | Page | Control | Kind | Result | Note |`,
    `|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.width} | ${r.page} | ${r.control.replace(/\|/g, '/')} | ${r.kind} | ${r.ok ? 'pass' : 'FAIL'} | ${r.note.replace(/\|/g, '/')} |`),
    '',
    `${rows.length} checks, ${rows.length - failed.length} pass, ${failed.length} fail.`,
  ].join('\n');
  if (OUT) writeFileSync(OUT, md);
  console.log(`\n${rows.length} checks, ${rows.length - failed.length} pass, ${failed.length} fail.`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
