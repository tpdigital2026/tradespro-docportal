import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { PageOverflowError, renderPdf } from '../../src/pdf/render';
import { buildReceipt } from '../../src/templates/receipt';
import { fakeBrand, fakeTenant } from '../fixtures/fake';
import { depositReceiptFixture, finalReceiptFixture } from '../fixtures/receipts';

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

describe('receipt', () => {
  it('deposit receipt: one page, amount paid, balance remaining £2,305.80, deposit stamp', async () => {
    const pdf = await renderPdf(page, buildReceipt(depositReceiptFixture, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(1);
    const t = await text();
    for (const s of ['Receipt', 'RCP-JS-001-D', 'INV-JS-001-D', '£988.20', '£2,305.80', 'Bank transfer', 'DEPOSIT', '07 · 10 · 2026']) {
      expect(t.toUpperCase()).toContain(s.toUpperCase());
    }
    expect(t).toContain('due on completion of works (quote QT-JS-001, total £3,294.00 inc. VAT)');
    expect(t).toContain('GB 408094403');
  });

  it('final receipt: balance £0.00 and a paid-in-full stamp', async () => {
    await renderPdf(page, buildReceipt(finalReceiptFixture, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).toContain('£2,305.80');
    expect(t).toContain('£0.00');
    expect(t.toUpperCase()).toContain('PAID IN FULL');
    expect(t).toContain('Paid in full – no balance outstanding (quote QT-JS-001, total £3,294.00 inc. VAT).');
  });

  it('a part payment on the balance is not marked paid in full', async () => {
    const input = { ...finalReceiptFixture, amountPaidPence: 100000 };
    await renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand));
    const t = await text();
    expect(t.toUpperCase()).toContain('PART PAYMENT');
    expect(t).toContain('£1,305.80');
    expect(t).toContain('still outstanding');
  });

  it('rejects payments that exceed the quote total', () => {
    expect(() => buildReceipt({ ...finalReceiptFixture, amountPaidPence: 999999 }, fakeTenant, fakeBrand)).toThrow(RangeError);
  });

  it('omits the VAT number when the figures do not include VAT', async () => {
    const input = { ...depositReceiptFixture, vatIncluded: false, description: '30% Deposit – flat roof replacement' };
    await renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).not.toContain('VAT registration number');
    expect(t).not.toContain('inc. VAT');
  });

  it('escapes customer text', async () => {
    const input = { ...depositReceiptFixture, customer: { ...depositReceiptFixture.customer, name: '<img src=x onerror=alert(1)>' } };
    await renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand));
    expect(await page.$$eval('img[onerror]', (e) => e.length)).toBe(0);
  });

  it('fails closed when content runs into the footer', async () => {
    const input = { ...depositReceiptFixture, description: 'Very long description '.repeat(400) };
    await expect(renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand))).rejects.toBeInstanceOf(PageOverflowError);
  });
});
