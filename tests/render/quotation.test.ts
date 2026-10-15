import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderBrowser as Browser, RenderPage as Page } from '../../src/pdf/browser';
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
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g)).toHaveLength(4);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toContain('£7,505.00');
    expect(text).toContain('£1,501.00');
    expect(text).toContain('£9,006.00');
  });

  it('uses the cover title as the running header label', async () => {
    await renderPdf(page, await buildQuotation(page, quotationFixture, fjcTenant, loadFjcBrand()));
    const labels = await page.$$eval('.page:nth-of-type(2) .rh .eyebrow', (e) => e.map((x) => x.textContent));
    expect(labels).toEqual([quotationFixture.coverTitle]);
    const h2s = await page.$$eval('.page:last-of-type h2', (e) => e.map((x) => x.textContent));
    expect(h2s).toContain('Your investment');
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
    const pdf = await renderPdf(page, doc);
    const count = await page.$$eval('.page', (p) => p.length);
    expect(count).toBeGreaterThan(4);
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g)).toHaveLength(count);
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

  const build = (over: Partial<typeof quotationFixture>) =>
    buildQuotation(page, { ...quotationFixture, ...over }, fjcTenant, loadFjcBrand());
  const line = (i: number) => ({
    description: `Additional item ${i}, supplied and fitted as described`,
    kind: 'Work',
    qty: 1,
    unitNetPence: 10000,
    vatApplies: true,
  });

  it('passes a normal two-line quote', async () => {
    await expect(renderPdf(page, await build({}))).resolves.toBeInstanceOf(Buffer);
  });

  it('fails when many price lines run into the disclaimer', async () => {
    const lines = [...quotationFixture.lines, ...[1, 2, 3, 4, 5, 6].map(line)];
    await expect(renderPdf(page, await build({ lines }))).rejects.toThrow(/reserved fine/);
  });

  it('fails when the intro runs over the contents strip', async () => {
    const introText = Array(4).fill(quotationFixture.introText).join(' ');
    await expect(renderPdf(page, await build({ introText }))).rejects.toThrow(/reserved toc/);
  });

  it('fails when a long cover title pushes the strip out of the hero', async () => {
    const coverTitle = 'Complete Flat Roof Installation and Full Replacement Quotation With Lead Flashing and Drainage';
    const coverSub = Array(6).fill(quotationFixture.coverSub).join(', ');
    await expect(renderPdf(page, await build({ coverTitle, coverSub }))).rejects.toThrow(/page 1: content is clipped inside \.in/);
  });
});
