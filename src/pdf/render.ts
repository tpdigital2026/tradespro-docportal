import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inStage, tagStage } from './diagnostics';
import type { RenderPage } from './engine';

export class PageOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageOverflowError';
  }
}

async function load(page: RenderPage, docHtml: string): Promise<void> {
  await inStage('layout', async () => {
    await page.setContent(docHtml);
    await page.emulatePrint();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
  });
}

export async function assertNoOverflow(page: RenderPage): Promise<void> {
  const result = await inStage('check', () => page.evaluate(() => {
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

      // Horizontal: nothing may run off the side of the page, and boxes must not be wider than themselves.
      const pr = pg.getBoundingClientRect();
      for (const el of pg.querySelectorAll<HTMLElement>('*')) {
        const isLeaf = el.children.length === 0 && (el.textContent ?? '').trim() !== '';
        if (!(isLeaf || el.tagName === 'IMG')) continue;
        const e = el.getBoundingClientRect();
        if (e.width === 0 && e.height === 0) continue;
        if (e.right > pr.right + tol || e.left < pr.left - tol) {
          problems.push(`page ${n}: content runs off the side of the page`);
          break;
        }
      }
      const boxes = new Set<HTMLElement>(pg.querySelectorAll<HTMLElement>('.body, .fbody, [data-fit]'));
      boxes.forEach((el) => {
        if (el.scrollWidth > el.clientWidth + tol) problems.push(`page ${n}: content is wider than its box`);
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
  }));
  if (result.none) throw tagStage(new PageOverflowError('No .page elements found'), 'check');
  if (result.problems.length > 0) throw tagStage(new PageOverflowError(result.problems.join('; ')), 'check');
}

export async function renderPdf(page: RenderPage, docHtml: string): Promise<Buffer> {
  await load(page, docHtml);
  await assertNoOverflow(page);
  return inStage('pdf', () => page.pdf());
}

/** One PNG per .page of the document currently in the page (call after renderPdf). */
export function screenshotEachPage(page: RenderPage): Promise<Buffer[]> {
  return inStage('screenshot', () => page.screenshotAll('.page'));
}

export async function screenshotPages(page: RenderPage, docHtml: string, outDir: string): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  await load(page, docHtml);
  const pngs = await screenshotEachPage(page);
  const files: string[] = [];
  for (let i = 0; i < pngs.length; i++) {
    const file = path.join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`);
    writeFileSync(file, pngs[i]);
    files.push(file);
  }
  return files;
}
