import { chromium, type Browser, type Page } from 'playwright-core';

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? DEFAULT_CHROME });
}

/** A page that cannot reach the network. data: URLs are not intercepted, so embedded assets still load. */
export async function newLockedPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 794, height: 1123 },
    acceptDownloads: false,
  });
  await context.route('**/*', (route) => route.abort());
  return context.newPage();
}
