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
});
