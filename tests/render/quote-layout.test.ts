import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderBrowser as Browser, RenderPage as Page } from '../../src/pdf/browser';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { renderPdf } from '../../src/pdf/render';
import { buildQuotation } from '../../src/templates/quotation';
import { fakeBrand, fakeTenant } from '../fixtures/fake';
import { quotationFixture, shortQuotationFixture } from '../fixtures/quotation';

// These run on any checkout (fake brand images), unlike tests/render/quotation.test.ts which needs the reference assets.
let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await launchBrowser();
  page = await newLockedPage(browser);
});
afterAll(async () => {
  await browser.close();
});

const pdfPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
const tocCells = () =>
  page.$$eval('.toc > div', (rows) => rows.map((r) => [r.querySelector('.l')?.textContent ?? '', Number((r.querySelector('.p')?.textContent ?? '').replace(/\D/g, ''))] as [string, number]));
const pageIndexOf = (sel: string) => page.$$eval('.page', (ps, q) => ps.findIndex((p) => p.querySelector(q) !== null) + 1, sel);

describe('a short quote, laid out as the owner\'s real short quotes are', () => {
  it('shares one page between the specification and the scope, so it is three pages', async () => {
    const pdf = await renderPdf(page, await buildQuotation(page, shortQuotationFixture, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(3);
    expect(await pageIndexOf('.cards')).toBe(2);
    expect(await pageIndexOf('.scope-sec')).toBe(2);
    expect(await page.$$eval('.page:nth-of-type(2) .cards, .page:nth-of-type(2) .scope-sec', (e) => e.length)).toBeGreaterThan(1);
  });

  it('the contents strip has four cells, with Pricing and Terms split when there is no guarantee', async () => {
    await renderPdf(page, await buildQuotation(page, shortQuotationFixture, fakeTenant, fakeBrand));
    expect(await tocCells()).toEqual([['Specification', 2], ['Scope of works', 2], ['Pricing', 3], ['Terms', 3]]);
  });

  it('the pricing page is headed "Your quotation" and the price row names the job and the first address line', async () => {
    await renderPdf(page, await buildQuotation(page, shortQuotationFixture, fakeTenant, fakeBrand));
    expect(await page.$$eval('.page:last-of-type h2', (e) => e.map((x) => x.textContent))).toContain('Your quotation');
    expect(await page.$$eval('table.px tbody td:first-child', (e) => e.map((x) => x.textContent))).toEqual(['Fascia replacement – 123 Bromley Road, complete works as specified above']);
  });

  it('the validity line stays on one line next to its label', async () => {
    await renderPdf(page, await buildQuotation(page, shortQuotationFixture, fakeTenant, fakeBrand));
    const lines = await page.$$eval('.kv', (rows) => {
      const row = rows.find((r) => r.querySelector('.k')?.textContent === 'Validity');
      const v = row?.querySelector<HTMLElement>('.v');
      return v ? Math.round(v.getBoundingClientRect().height / parseFloat(getComputedStyle(v).lineHeight)) : 0;
    });
    expect(lines).toBe(1);
  });

  it('a scope too long to share the page goes on its own page, as the long quotes do', async () => {
    const long = { ...shortQuotationFixture, scope: quotationFixture.scope };
    const pdf = await renderPdf(page, await buildQuotation(page, long, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(4);
    expect(await pageIndexOf('.cards')).toBe(2);
    expect(await pageIndexOf('.scope-sec')).toBe(3);
    expect(await tocCells()).toEqual([['Specification', 2], ['Scope of works', 3], ['Pricing', 4], ['Terms', 4]]);
  });

  it('with a guarantee the last cell stays "Pricing & terms" and the guarantee is listed', async () => {
    const guaranteed = { ...shortQuotationFixture, guarantee: quotationFixture.guarantee };
    await renderPdf(page, await buildQuotation(page, guaranteed, fakeTenant, fakeBrand));
    const cells = await tocCells();
    expect(cells.map(([l]) => l)).toEqual(['Specification', 'Scope of works', 'Guarantee', 'Pricing & terms']);
    expect(cells[2][1]).toBe(await pageIndexOf('.gband'));
  });

  it('a quote with a diagram keeps the specification on its own page', async () => {
    const pdf = await renderPdf(page, await buildQuotation(page, { ...shortQuotationFixture, diagram: quotationFixture.diagram }, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(4);
    expect(await pageIndexOf('.scope-sec')).toBe(3);
  });
});
