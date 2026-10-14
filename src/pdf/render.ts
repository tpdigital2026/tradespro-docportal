import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';

export class PageOverflowError extends Error {}

async function load(page: Page, docHtml: string): Promise<void> {
  await page.setContent(docHtml, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'print' });
}

export async function assertNoOverflow(page: Page): Promise<void> {
  const bad = await page.evaluate(() => {
    const out: number[] = [];
    document.querySelectorAll<HTMLElement>('.page').forEach((pg, i) => {
      const body = pg.querySelector<HTMLElement>('.body');
      const bodyOver = body ? body.scrollHeight > body.clientHeight + 1 : false;
      if (pg.scrollHeight > pg.clientHeight + 1 || bodyOver) out.push(i + 1);
    });
    return out;
  });
  if (bad.length > 0) throw new PageOverflowError(`Content overflows page ${bad.join(', ')}`);
}

export async function renderPdf(page: Page, docHtml: string): Promise<Buffer> {
  await load(page, docHtml);
  await assertNoOverflow(page);
  return page.pdf({ preferCSSPageSize: true, printBackground: true });
}

export async function screenshotPages(page: Page, docHtml: string, outDir: string): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  await load(page, docHtml);
  const pages = await page.$$('.page');
  const files: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const file = path.join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`);
    await pages[i].screenshot({ path: file });
    files.push(file);
  }
  return files;
}
