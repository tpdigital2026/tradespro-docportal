import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderBrowser as Browser, RenderPage as Page } from '../../src/pdf/browser';
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
const stamp = () => page.$eval('.stamp', (e) => e.textContent ?? '');
const pdfPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

describe('receipt', () => {
  it('deposit receipt: one page, amount paid, balance remaining £2,305.80, deposit stamp', async () => {
    const pdf = await renderPdf(page, buildReceipt(depositReceiptFixture, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(1);
    const t = await text();
    for (const s of ['Receipt', 'RCP-JS-001-D', 'INV-JS-001-D', '£988.20', '£2,305.80', 'Bank transfer']) {
      expect(t.toUpperCase()).toContain(s.toUpperCase());
    }
    expect(await stamp()).toBe('DepositPAID07 · 10 · 2026');
    expect(t).toContain('due on completion of works (quote QT-JS-001, total £3,294.00 inc. VAT)');
    expect(t).toContain('GB 408094403');
  });

  it('final receipt: balance £0.00 and a paid-in-full stamp', async () => {
    await renderPdf(page, buildReceipt(finalReceiptFixture, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).toContain('£2,305.80');
    expect(t).toContain('£0.00');
    expect(await stamp()).toBe('Paid in fullPAID11 · 10 · 2026');
    expect(t).toContain('Paid in full – no balance outstanding (quote QT-JS-001, total £3,294.00 inc. VAT).');
  });

  it('a part payment on the balance is not marked paid in full', async () => {
    const input = { ...finalReceiptFixture, amountPaidPence: 100000 };
    await renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand));
    const t = await text();
    expect(await stamp()).toBe('Part paymentPAID11 · 10 · 2026');
    expect(t).toContain('£1,305.80');
    expect(t).toContain('still outstanding');
  });

  it('rejects payments that exceed the quote total', () => {
    expect(() => buildReceipt({ ...finalReceiptFixture, amountPaidPence: 999999 }, fakeTenant, fakeBrand)).toThrow(RangeError);
  });

  it('rejects a zero or negative amount paid and non-positive previous payments', () => {
    expect(() => buildReceipt({ ...depositReceiptFixture, amountPaidPence: 0 }, fakeTenant, fakeBrand)).toThrow(RangeError);
    expect(() => buildReceipt({ ...depositReceiptFixture, amountPaidPence: -5 }, fakeTenant, fakeBrand)).toThrow(RangeError);
    expect(() => buildReceipt({ ...finalReceiptFixture, previousPaymentsPence: [0] }, fakeTenant, fakeBrand)).toThrow(RangeError);
    expect(() => buildReceipt({ ...finalReceiptFixture, previousPaymentsPence: [-100] }, fakeTenant, fakeBrand)).toThrow(RangeError);
  });

  it('takes the deposit balance wording from the input', async () => {
    await renderPdf(page, buildReceipt({ ...depositReceiptFixture, balanceDueLabel: 'Due on practical completion' }, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).toContain('Due on practical completion');
    expect(t).toContain('due on practical completion (quote QT-JS-001');
  });

  it('long payment method: rejects or wraps without running off the page', async () => {
    let result = 'wrapped';
    try {
      await renderPdf(page, buildReceipt({ ...depositReceiptFixture, method: 'M'.repeat(44) }, fakeTenant, fakeBrand));
    } catch (e) {
      expect(e).toBeInstanceOf(PageOverflowError);
      result = 'rejected';
    }
    if (result === 'wrapped') {
      const off = await page.$$eval('.page *', (els) => {
        const pr = document.querySelector('.page')!.getBoundingClientRect();
        return els.filter((e) => (e.children.length === 0 && (e.textContent ?? '').trim() !== '') || e.tagName === 'IMG').filter((e) => e.getBoundingClientRect().right > pr.right + 1).length;
      });
      expect(off).toBe(0);
    }
    process.stderr.write(`unbroken receipt method: ${result}\n`);
  });

  it('omits the VAT number when the figures do not include VAT', async () => {
    const input = { ...depositReceiptFixture, vatIncluded: false, description: '30% Deposit – flat roof replacement' };
    await renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).not.toContain('VAT registration number');
    expect(t).not.toContain('inc. VAT');
  });

  it('escapes untrusted text in every free-text field', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const input = {
      ...depositReceiptFixture,
      customer: { ...depositReceiptFixture.customer, name: payload },
      method: payload,
      description: payload,
      invoiceRef: payload,
      receiptNo: payload,
      paidDateLabel: payload,
    };
    const doc = buildReceipt(input, fakeTenant, fakeBrand);
    expect(doc).not.toContain('<script');
    await renderPdf(page, doc);
    expect(await page.$$eval('img[onerror]', (e) => e.length)).toBe(0);
    expect(await page.$$eval('script', (e) => e.length)).toBe(0);
    const t = await text();
    expect(t).toContain(payload);
    expect(t.split(payload).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('fails closed when content runs into the footer', async () => {
    const input = { ...depositReceiptFixture, description: 'Very long description '.repeat(400) };
    await expect(renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand))).rejects.toBeInstanceOf(PageOverflowError);
  });
});
