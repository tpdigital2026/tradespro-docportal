import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';

export class PageOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageOverflowError';
  }
}

async function load(page: Page, docHtml: string): Promise<void> {
  await page.setContent(docHtml, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => document.fonts.ready);
}

export async function assertNoOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const problems: string[] = [];
    const pages = [...document.querySelectorAll<HTMLElement>('.page')];
    if (pages.length === 0) return { none: true, problems };
    const tol = 1;
    pages.forEach((pg, i) => {
      const n = i + 1;
      const body = pg.querySelector<HTMLElement>('.body');
      if (pg.scrollHeight > pg.clientHeight + tol) problems.push(`page ${n}: content overflows the page`);
      if (body && body.scrollHeight > body.clientHeight + tol) problems.push(`page ${n}: content overflows .body`);

      // Clipping boxes: anything that hides its overflow, plus every [data-fit] box.
      const clipped = new Set<HTMLElement>(pg.querySelectorAll<HTMLElement>('[data-fit]'));
      pg.querySelectorAll<HTMLElement>('*').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.overflow !== 'visible' || cs.overflowY !== 'visible') clipped.add(el);
      });
      clipped.forEach((el) => {
        if (el.scrollHeight > el.clientHeight + tol) {
          problems.push(`page ${n}: content is clipped inside .${el.className.split(' ')[0] || el.tagName.toLowerCase()}`);
        }
      });

      // Reserved absolute boxes must not be overlapped by in-flow content.
      pg.querySelectorAll<HTMLElement>('[data-reserved]').forEach((box) => {
        const r = box.getBoundingClientRect();
        pg.querySelectorAll<HTMLElement>('*').forEach((el) => {
          if (box.contains(el) || el.closest('.rh, .rf')) return;
          const isLeaf = el.children.length === 0 && (el.textContent ?? '').trim() !== '';
          if (!(isLeaf || el.tagName === 'IMG' || el.tagName === 'TR')) return;
          const e = el.getBoundingClientRect();
          const overlapX = Math.min(e.right, r.right) - Math.max(e.left, r.left);
          const overlapY = Math.min(e.bottom, r.bottom) - Math.max(e.top, r.top);
          if (overlapX > tol && overlapY > tol) {
            problems.push(`page ${n}: content overlaps the reserved ${box.className.split(' ')[0] || 'box'}`);
          }
        });
      });
    });
    return { none: false, problems: [...new Set(problems)] };
  });
  if (result.none) throw new PageOverflowError('No .page elements found');
  if (result.problems.length > 0) throw new PageOverflowError(result.problems.join('; '));
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
