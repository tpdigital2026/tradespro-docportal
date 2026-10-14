import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { PageOverflowError, renderPdf } from '../../src/pdf/render';
import { buildGuarantee } from '../../src/templates/guarantee';
import { fakeBrand, fakeTenant } from '../fixtures/fake';
import { guaranteeFixture } from '../fixtures/guarantee';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await launchBrowser();
  page = await newLockedPage(browser);
});
afterAll(async () => {
  await browser.close();
});

// textContent, not innerText: innerText applies the stylesheet's text-transform:uppercase to labels.
const text = () => page.evaluate(() => document.body.textContent ?? '');
const pdfPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

describe('guarantee certificate', () => {
  it('renders one page with the supplied wording', async () => {
    const pdf = await renderPdf(page, buildGuarantee(guaranteeFixture, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(1);
    const t = await text();
    for (const s of [
      'Certificate of',
      'Guarantee',
      'This certifies that the dormer flat roof installed at',
      '123 Bromley Road, Bromley, BR2 8BG',
      'was installed by',
      'INSTALLATION COMPLETED · 06/10/2026',
      guaranteeFixture.statement,
      'GC-JS-001',
      'Ben Cunningham',
      'COMPANY NO. 13855379',
    ]) {
      expect(t).toContain(s);
    }
    expect(t.toUpperCase()).toContain('WE CANNOT BE HELD RESPONSIBLE FOR MISUSE OF OUR PRODUCTS BY THE CUSTOMER');
  });

  const sealFont = () => page.$eval('svg textPath', (el) => ({ text: el.textContent ?? '', px: parseFloat(getComputedStyle(el.parentElement as Element).fontSize) }));

  it('seal text names the business and the years at full size for a normal name', async () => {
    await renderPdf(page, buildGuarantee(guaranteeFixture, fakeTenant, fakeBrand));
    const seal = await sealFont();
    expect(seal.text).toContain('FJC ROOFING LTD');
    expect(seal.text).toContain('20 YEAR GUARANTEE');
    expect(seal.px).toBe(10);
  });

  it('shrinks the seal text for a long business name so it cannot overlap', async () => {
    const tenant = { ...fakeTenant, name: 'Bromley Kitchens and Bathrooms Roofing Ltd '.padEnd(60, 'x') };
    expect(tenant.name).toHaveLength(60);
    await renderPdf(page, buildGuarantee(guaranteeFixture, tenant, fakeBrand));
    const { px } = await sealFont();
    expect(px).toBeLessThan(10);
    expect(px).toBeGreaterThanOrEqual(6);
  });

  it('fails closed when the business name cannot fit the seal', () => {
    const tenant = { ...fakeTenant, name: 'N'.repeat(200) };
    expect(() => buildGuarantee(guaranteeFixture, tenant, fakeBrand)).toThrow(/too long/);
  });

  it('leaves the disclaimer line out when none is given', async () => {
    await renderPdf(page, buildGuarantee({ ...guaranteeFixture, disclaimerLine: null }, fakeTenant, fakeBrand));
    expect((await text()).toUpperCase()).not.toContain('MISUSE');
  });

  it('escapes input text, including inside the seal', async () => {
    const tenant = { ...fakeTenant, name: 'A <b>&</b> Co' };
    const input = { ...guaranteeFixture, address: '<img src=x onerror=alert(1)>' };
    await renderPdf(page, buildGuarantee(input, tenant, fakeBrand));
    expect(await page.$$eval('img[onerror]', (e) => e.length)).toBe(0);
    // The seal label is the uppercased tenant name, escaped: literal text, not markup.
    expect((await sealFont()).text).toContain('A <B>&</B> CO');
    // The HTML parser hoists a stray <b> out of <svg>, so count every <b> in the page.
    // The template emits exactly one: the "installed by" business name, whose content is escaped text.
    expect(await page.$$eval('b', (e) => e.length)).toBe(1);
  });

  it('fails closed when the content does not fit the frame', async () => {
    const input = { ...guaranteeFixture, address: 'A very long address line '.repeat(60) };
    await expect(renderPdf(page, buildGuarantee(input, fakeTenant, fakeBrand))).rejects.toBeInstanceOf(PageOverflowError);
  });
});
