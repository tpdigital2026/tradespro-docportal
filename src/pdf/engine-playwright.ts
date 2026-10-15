/**
 * RenderBrowser on playwright-core. Local development and tests only: Playwright supports exactly its own Chromium
 * revision, so it is never used with the serverless binary (see engine.ts).
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { VIEWPORT, type RenderBrowser, type RenderPage } from './engine';

function wrapPage(page: Page, owner: BrowserContext | null): RenderPage {
  // The overloads in RenderPage are satisfied by these loosely typed implementations.
  const evaluate = (fn: (arg?: unknown) => unknown, arg?: unknown) => page.evaluate(fn as (a: unknown) => unknown, arg);
  const $$eval = (selector: string, fn: (els: Element[], arg?: unknown) => unknown, arg?: unknown) =>
    page.$$eval(selector, fn as (els: Element[], a: unknown) => unknown, arg);
  return {
    async setContent(html) {
      await page.setContent(html, { waitUntil: 'load' });
    },
    async emulatePrint() {
      await page.emulateMedia({ media: 'print' });
    },
    evaluate: evaluate as RenderPage['evaluate'],
    $$eval: $$eval as RenderPage['$$eval'],
    $eval: ((selector: string, fn: (el: Element) => unknown) => page.$eval(selector, fn)) as RenderPage['$eval'],
    async waitForFunction(fn) {
      await page.waitForFunction(fn);
    },
    async pdf() {
      return page.pdf({ preferCSSPageSize: true, printBackground: true });
    },
    async screenshotAll(selector) {
      const out: Buffer[] = [];
      for (const el of await page.$$(selector)) out.push(await el.screenshot({ type: 'png' }));
      return out;
    },
    onRequestFailed(listener) {
      const fn = (r: { url(): string }) => listener(r.url());
      page.on('requestfailed', fn);
      return () => {
        page.off('requestfailed', fn);
      };
    },
    async close() {
      if (owner) await owner.close().catch(() => undefined);
      else await page.close().catch(() => undefined);
    },
  };
}

export function wrapPlaywright(browser: Browser): RenderBrowser {
  return {
    engine: 'playwright',
    async newLockedPage() {
      const context = await browser.newContext({
        deviceScaleFactor: VIEWPORT.deviceScaleFactor,
        viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
        acceptDownloads: false,
      });
      await context.route('**/*', (route) => route.abort());
      return wrapPage(await context.newPage(), context);
    },
    async newUnlockedPageForTests() {
      const context = await browser.newContext({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height } });
      return wrapPage(await context.newPage(), context);
    },
    isConnected: () => browser.isConnected(),
    close: () => browser.close(),
  };
}

export async function launchPlaywright(executablePath: string): Promise<RenderBrowser> {
  const { chromium } = await import('playwright-core');
  return wrapPlaywright(await chromium.launch({ executablePath }));
}
