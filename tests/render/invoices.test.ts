import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { PageOverflowError, renderPdf } from '../../src/pdf/render';
import { buildBalanceInvoice, buildDepositInvoice } from '../../src/templates/invoice';
import { fakeBrand, fakeTenant } from '../fixtures/fake';
import { balanceInvoiceFixture, depositInvoiceFixture } from '../fixtures/invoices';

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

describe('deposit invoice', () => {
  it('renders two pages with the deposit maths from money.ts', async () => {
    const doc = await buildDepositInvoice(page, depositInvoiceFixture, fakeTenant, fakeBrand);
    const pdf = await renderPdf(page, doc);
    expect(await page.$$eval('.page', (p) => p.length)).toBe(2);
    expect(pdfPages(pdf)).toBe(2);
    const t = await text();
    for (const s of ['Deposit Invoice', 'INV-JS-001-D', 'QT-JS-001', '£988.20', '£823.50', '£164.70', '£3,294.00', '£2,305.80', '30% Deposit']) {
      expect(t).toContain(s);
    }
    expect(t).toContain(depositInvoiceFixture.terms);
    expect(t).toContain('Balance due on completion');
  });

  it('shows the dummy bank details and the payment reference', async () => {
    await renderPdf(page, await buildDepositInvoice(page, depositInvoiceFixture, fakeTenant, fakeBrand));
    const t = await text();
    for (const s of ['Metro Bank', '00-00-00', '00000000', depositInvoiceFixture.paymentRef]) expect(t).toContain(s);
  });

  it('omits the guarantee band when there is no guarantee', async () => {
    const doc = await buildDepositInvoice(page, { ...depositInvoiceFixture, guarantee: null }, fakeTenant, fakeBrand);
    await renderPdf(page, doc);
    expect(await page.$$eval('.gband', (e) => e.length)).toBe(0);
  });

  it('drops VAT rows and the VAT number when the job has no VAT', async () => {
    const input = {
      ...depositInvoiceFixture,
      quoteLines: depositInvoiceFixture.quoteLines.map((l) => ({ ...l, vatApplies: false })),
    };
    await renderPdf(page, await buildDepositInvoice(page, input, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).not.toContain('VAT registration number');
    expect(t).not.toContain('Subtotal');
    expect(t).toContain('Quote total');
    expect(t).not.toContain('Quote total (inc. VAT)');
  });

  it('escapes customer text', async () => {
    const input = { ...depositInvoiceFixture, customer: { ...depositInvoiceFixture.customer, name: '<img src=x onerror=alert(1)>' } };
    await renderPdf(page, await buildDepositInvoice(page, input, fakeTenant, fakeBrand));
    expect(await page.$$eval('img[onerror]', (e) => e.length)).toBe(0);
    expect(await text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('flows a long scope onto extra pages with consistent footers', async () => {
    const extra = depositInvoiceFixture.scope.map((s) => ({ ...s, heading: `${s.heading} (additional)` }));
    const input = { ...depositInvoiceFixture, scope: [...depositInvoiceFixture.scope, ...extra, ...extra, ...extra] };
    const pdf = await renderPdf(page, await buildDepositInvoice(page, input, fakeTenant, fakeBrand));
    const count = await page.$$eval('.page', (p) => p.length);
    expect(count).toBeGreaterThan(2);
    expect(pdfPages(pdf)).toBe(count);
    const pg = await page.$$eval('.rf .pg', (els) => els.map((e) => e.textContent ?? ''));
    expect(pg).toHaveLength(count);
    pg.forEach((t, i) => expect(t).toContain(`${String(i + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}`));
  });

  it('rejects an empty scope', async () => {
    await expect(buildDepositInvoice(page, { ...depositInvoiceFixture, scope: [] }, fakeTenant, fakeBrand)).rejects.toThrow(/scope/i);
  });

  it('fails closed when the pricing page would collide with the disclaimer', async () => {
    const long = { ...depositInvoiceFixture, disclaimer: 'x '.repeat(4000) };
    const run = renderPdf(page, await buildDepositInvoice(page, long, fakeTenant, fakeBrand));
    await expect(run).rejects.toBeInstanceOf(PageOverflowError);
    await expect(run).rejects.toThrow(/overlaps the reserved|overflows/);
  });
});

// Unbroken tokens either fail closed or wrap; in both cases nothing may run off the page.
async function outcome(run: () => Promise<unknown>): Promise<'rejected' | 'wrapped'> {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(PageOverflowError);
    return 'rejected';
  }
  const off = await page.$$eval('.page', (pages) =>
    pages.flatMap((pg) => {
      const pr = pg.getBoundingClientRect();
      return [...pg.querySelectorAll<HTMLElement>('*')]
        .filter((e) => e.tagName === 'IMG' || (e.children.length === 0 && (e.textContent ?? '').trim() !== ''))
        .filter((e) => e.getBoundingClientRect().right > pr.right + 1)
        .map((e) => e.className);
    }),
  );
  expect(off).toEqual([]);
  return 'wrapped';
}

describe('unbroken tokens', () => {
  it('long customer name and payment reference', async () => {
    const name = 'A'.repeat(120);
    const r1 = await outcome(async () =>
      renderPdf(page, await buildDepositInvoice(page, { ...depositInvoiceFixture, customer: { ...depositInvoiceFixture.customer, name } }, fakeTenant, fakeBrand)),
    );
    const ref = 'R'.repeat(63);
    const r2 = await outcome(async () =>
      renderPdf(page, await buildDepositInvoice(page, { ...depositInvoiceFixture, paymentRef: ref }, fakeTenant, fakeBrand)),
    );
    process.stderr.write(`unbroken invoice name: ${r1}; paymentRef: ${r2}\n`);
  });
});

describe('balance invoice', () => {
  it('renders the balance split 1,921.50 + 384.30 = 2,305.80 with the deposit received', async () => {
    const pdf = await renderPdf(page, await buildBalanceInvoice(page, balanceInvoiceFixture, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(2);
    const t = await text();
    for (const s of ['Balance Invoice', 'INV-JS-001-B', '£1,921.50', '£384.30', '£2,305.80', '£3,294.00', '30% deposit received', '£988.20', 'receipt RCP-JS-001-D']) {
      expect(t).toContain(s);
    }
    expect(t).toContain(balanceInvoiceFixture.terms);
    expect(t).toContain(balanceInvoiceFixture.dueNote);
  });

  it('accepts a matching deposit and rejects a different one', async () => {
    await expect(buildBalanceInvoice(page, { ...balanceInvoiceFixture, depositReceivedPence: 98820 }, fakeTenant, fakeBrand)).resolves.toBeDefined();
    await expect(buildBalanceInvoice(page, { ...balanceInvoiceFixture, depositReceivedPence: 100000 }, fakeTenant, fakeBrand)).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects mixed VAT and non-VAT lines', async () => {
    const mixed = [...balanceInvoiceFixture.quoteLines, { description: 'Zero rated', kind: 'Work', qty: 1, unitNetPence: 1000, vatApplies: false }];
    await expect(buildBalanceInvoice(page, { ...balanceInvoiceFixture, quoteLines: mixed }, fakeTenant, fakeBrand)).rejects.toThrow(/Mixed VAT/);
    await expect(buildDepositInvoice(page, { ...depositInvoiceFixture, quoteLines: mixed }, fakeTenant, fakeBrand)).rejects.toThrow(/Mixed VAT/);
  });

  it('shows extras and credits on top of the quote', async () => {
    const input = {
      ...balanceInvoiceFixture,
      adjustmentLines: [
        { description: 'Extra ply boards', kind: 'Extra', qty: 2, unitNetPence: 5000, vatApplies: true },
        { description: 'Goodwill credit', kind: 'Credit', qty: 1, unitNetPence: -2500, vatApplies: true },
      ],
    };
    await renderPdf(page, await buildBalanceInvoice(page, input, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).toContain('Extras and credits (inc. VAT)');
    expect(t).toContain('£90.00'); // (10000 - 2500) net + 20% = 9000p
  });

  it('leaves the receipt reference out when there is none', async () => {
    const input = { ...balanceInvoiceFixture, depositReceiptRef: null };
    await renderPdf(page, await buildBalanceInvoice(page, input, fakeTenant, fakeBrand));
    expect(await text()).not.toContain('(receipt');
  });
});
