/**
 * RenderBrowser on puppeteer-core. This is the engine on Vercel (launched by serverless-chromium.ts) and it also runs
 * locally against an installed Chrome, so the render test suite exercises this exact code under
 * RENDER_ENGINE=puppeteer (npm run test:render:puppeteer).
 *
 * Pages are opened in the browser's default context, not a fresh BrowserContext per render: with @sparticuz/chromium's
 * --single-process flag, creating extra contexts is known to fail with "Target closed" (sparticuz/chromium#298). The
 * pages never touch the network and never set cookies, so the default context isolates them well enough.
 */
import type { Browser, HTTPRequest, LaunchOptions, Page } from 'puppeteer-core';
import { VIEWPORT, type RenderBrowser, type RenderPage } from './engine';

const toBuffer = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

function wrapPage(page: Page): RenderPage {
  const evaluate = (fn: (arg?: unknown) => unknown, arg?: unknown) => page.evaluate(fn as (a: unknown) => unknown, arg);
  const $$eval = (selector: string, fn: (els: Element[], arg?: unknown) => unknown, arg?: unknown) =>
    page.$$eval(selector, fn as (els: Element[], a: unknown) => unknown, arg);
  return {
    async setContent(html) {
      // puppeteer's setContent rewrites the current document (document.open/write), which keeps that document's
      // Content-Security-Policy. A fresh about:blank first gives every document its own policy, as Playwright does.
      await page.goto('about:blank');
      await page.setContent(html, { waitUntil: 'load' });
    },
    async emulatePrint() {
      await page.emulateMediaType('print');
    },
    evaluate: evaluate as RenderPage['evaluate'],
    $$eval: $$eval as RenderPage['$$eval'],
    $eval: ((selector: string, fn: (el: Element) => unknown) => page.$eval(selector, fn)) as RenderPage['$eval'],
    async waitForFunction(fn) {
      await page.waitForFunction(fn);
    },
    async pdf() {
      return toBuffer(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
    },
    async screenshotAll(selector) {
      const out: Buffer[] = [];
      for (const el of await page.$$(selector)) out.push(toBuffer(await el.screenshot({ type: 'png' })));
      return out;
    },
    onRequestFailed(listener) {
      const fn = (r: HTTPRequest) => listener(r.url());
      page.on('requestfailed', fn);
      return () => {
        page.off('requestfailed', fn);
      };
    },
    async close() {
      await page.close().catch(() => undefined);
    },
  };
}

/** Aborts every request except data: URLs (puppeteer never intercepts those anyway; continuing them is harmless). */
function lock(req: HTTPRequest): void {
  if (req.isInterceptResolutionHandled()) return;
  const done = req.url().startsWith('data:') ? req.continue() : req.abort('blockedbyclient');
  done.catch(() => undefined);
}

export function wrapPuppeteer(browser: Browser): RenderBrowser {
  async function open(locked: boolean): Promise<RenderPage> {
    const page = await browser.newPage();
    try {
      await page.setViewport({ ...VIEWPORT });
      if (locked) {
        await page.setRequestInterception(true);
        page.on('request', lock);
      }
    } catch (e) {
      await page.close().catch(() => undefined);
      throw e;
    }
    return wrapPage(page);
  }
  return {
    engine: 'puppeteer',
    newLockedPage: () => open(true),
    newUnlockedPageForTests: () => open(false),
    isConnected: () => browser.connected,
    async close() {
      // Closing every page first avoids the hang on close that @sparticuz/chromium's FAQ describes.
      for (const p of await browser.pages().catch(() => [])) await p.close().catch(() => undefined);
      await browser.close();
    },
  };
}

export async function launchPuppeteer(options: LaunchOptions): Promise<RenderBrowser> {
  const puppeteer = (await import('puppeteer-core')).default;
  // CDP, stated rather than defaulted: the WebDriver BiDi path loads chromium-bidi, which is not traced into the bundle.
  return wrapPuppeteer(await puppeteer.launch({ protocol: 'cdp', ...options }));
}

/** Local Chrome (development and the render tests under RENDER_ENGINE=puppeteer). */
export function launchPuppeteerLocal(executablePath: string): Promise<RenderBrowser> {
  return launchPuppeteer({ executablePath, headless: true });
}
