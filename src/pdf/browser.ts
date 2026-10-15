import { DEFAULT_CHROME, renderEngine, renderRuntime, type RenderBrowser, type RenderPage } from './engine';
import { inStage } from './diagnostics';

export type { RenderBrowser, RenderPage } from './engine';

/**
 * Starts the browser this environment renders with (engine.ts): on Vercel, puppeteer-core with @sparticuz/chromium;
 * locally, Chrome at CHROMIUM_PATH (or the macOS default) driven by playwright-core, or by puppeteer-core with
 * RENDER_ENGINE=puppeteer. Engines are imported lazily so neither is loaded where it is not used.
 */
export async function launchBrowser(): Promise<RenderBrowser> {
  return inStage('launch', async () => {
    if (renderRuntime() === 'serverless') {
      const { launchServerlessChromium } = await import('./serverless-chromium');
      return launchServerlessChromium();
    }
    const executablePath = process.env.CHROMIUM_PATH ?? DEFAULT_CHROME;
    if (renderEngine() === 'puppeteer') {
      const { launchPuppeteerLocal } = await import('./engine-puppeteer');
      return launchPuppeteerLocal(executablePath);
    }
    const { launchPlaywright } = await import('./engine-playwright');
    return launchPlaywright(executablePath);
  });
}

/**
 * A page that cannot reach the network. data: URLs are not intercepted, so embedded assets still load.
 * Callers must call `page.close()` when done.
 */
export function newLockedPage(browser: RenderBrowser): Promise<RenderPage> {
  return inStage('page', () => browser.newLockedPage());
}
