import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { renderPdf } from '../../src/pdf/render';
import { buildQuotation } from '../../src/templates/quotation';
import { fjcTenant, loadFjcBrand, referenceAvailable } from '../fixtures/fjc';
import { quotationFixture } from '../fixtures/quotation';

describe.skipIf(!referenceAvailable)('quotation', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newLockedPage(browser);
  });
  afterAll(async () => {
    await browser.close();
  });

  it('renders four pages with the correct totals', async () => {
    const doc = await buildQuotation(page, quotationFixture, fjcTenant, loadFjcBrand());
    const pdf = await renderPdf(page, doc);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(await page.$$eval('.page', (p) => p.length)).toBe(4);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toContain('£7,505.00');
    expect(text).toContain('£1,501.00');
    expect(text).toContain('£9,006.00');
  });

  it('escapes customer-supplied text', async () => {
    const input = { ...quotationFixture, customer: { ...quotationFixture.customer, name: '<img src=x onerror=alert(1)>' } };
    const doc = await buildQuotation(page, input, fjcTenant, loadFjcBrand());
    await renderPdf(page, doc);
    expect(await page.$$eval('img[onerror]', (e) => e.length)).toBe(0);
    expect(await page.evaluate(() => document.body.innerText)).toContain('<img src=x onerror=alert(1)>');
  });

  it('flows a long scope onto extra pages and numbers the footers consistently', async () => {
    const extra = quotationFixture.scope.map((s) => ({ ...s, heading: `${s.heading} (additional)` }));
    const input = { ...quotationFixture, scope: [...quotationFixture.scope, ...extra, ...extra] };
    const doc = await buildQuotation(page, input, fjcTenant, loadFjcBrand());
    await renderPdf(page, doc);
    const count = await page.$$eval('.page', (p) => p.length);
    expect(count).toBeGreaterThan(4);
    const totals = await page.$$eval('.rf .pg', (els) => els.map((e) => e.textContent ?? ''));
    expect(totals).toHaveLength(count);
    totals.forEach((t, i) => {
      expect(t).toContain(`${String(i + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}`);
    });
  });

  const tocPage = (label: string) =>
    page.evaluate((l) => {
      const rows = [...document.querySelectorAll('.toc > div')];
      const row = rows.find((r) => r.querySelector('.l')?.textContent === l);
      return row ? Number(row.querySelector('.p')?.textContent?.replace(/\D/g, '')) : null;
    }, label);
  const pageIndexOf = (sel: string) =>
    page.$$eval('.page', (ps, q) => ps.findIndex((p) => p.querySelector(q) !== null) + 1, sel);

  it('ToC page numbers match where the guarantee and scope really are', async () => {
    const extra = quotationFixture.scope.map((s) => ({ ...s, heading: `${s.heading} (additional)` }));
    const long = { ...quotationFixture, scope: [...quotationFixture.scope, ...extra, ...extra] };
    for (const input of [quotationFixture, long]) {
      await renderPdf(page, await buildQuotation(page, input, fjcTenant, loadFjcBrand()));
      expect(await tocPage('Guarantee')).toBe(await pageIndexOf('.gband'));
      expect(await tocPage('Scope of works')).toBe(await pageIndexOf('.scope-sec'));
    }
  });

  it('omits the guarantee entirely when there is none', async () => {
    const input = { ...quotationFixture, guarantee: null };
    await renderPdf(page, await buildQuotation(page, input, fjcTenant, loadFjcBrand()));
    expect(await page.$$eval('.gband', (e) => e.length)).toBe(0);
    expect(await tocPage('Guarantee')).toBeNull();
  });

  it('shows no VAT anywhere when no line carries VAT', async () => {
    const input = { ...quotationFixture, lines: quotationFixture.lines.map((l) => ({ ...l, vatApplies: false })) };
    await renderPdf(page, await buildQuotation(page, input, fjcTenant, loadFjcBrand()));
    const text = await page.evaluate(() => document.body.innerText);
    expect(await page.$$eval('table.px th', (t) => t.map((x) => x.textContent))).not.toContain('VAT');
    expect(text).not.toContain('VAT registration number');
    expect(text).not.toContain('Subtotal');
    const strip = await page.$$eval('.cover-hero .strip div', (d) => d.map((x) => x.textContent ?? ''));
    expect(strip.some((t) => t.startsWith('Total') && !t.includes('VAT'))).toBe(true);
    expect(strip.some((t) => t.includes('Total inc. VAT'))).toBe(false);
  });

  it('rejects an empty scope', async () => {
    await expect(buildQuotation(page, { ...quotationFixture, scope: [] }, fjcTenant, loadFjcBrand())).rejects.toThrow(/scope/i);
  });
});
