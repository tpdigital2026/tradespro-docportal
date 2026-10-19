import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderBrowser as Browser, RenderPage as Page } from '../../src/pdf/browser';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { PageOverflowError, renderPdf } from '../../src/pdf/render';
import { buildBalanceInvoice, buildDepositInvoice, buildFullInvoice, buildStageInvoice } from '../../src/templates/invoice';
import { fakeBrand, fakeTenant } from '../fixtures/fake';
import { balanceInvoiceFixture, depositInvoiceFixture, fullInvoiceFixture, longBalanceInvoiceFixture, longDepositInvoiceFixture, stageInvoiceFixture } from '../fixtures/invoices';

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
    // {balance} in the owner's wording becomes the amount still to pay after the deposit.
    expect(t).toContain('The 30% deposit is payable before works start. The remaining balance of £2,305.80 is due on completion of works.');
    expect(t).not.toContain('{balance}');
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

/** The header's label and value pairs, read from the page (textContent, so the stylesheet's upper-casing does not matter). */
const headerMeta = () =>
  page.$$eval('.fhead .meta', (m) => {
    const spans = [...(m[0]?.querySelectorAll('span') ?? [])].map((s) => s.textContent ?? '');
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < spans.length; i += 2) out[spans[i]] = spans[i + 1];
    return out;
  });

describe('the Due line in the header', () => {
  it('deposit invoice: Due "Before works start"', async () => {
    await renderPdf(page, await buildDepositInvoice(page, depositInvoiceFixture, fakeTenant, fakeBrand));
    expect(await headerMeta()).toMatchObject({ Date: '07/10/2026', 'Invoice no.': 'INV-JS-001-D', 'Quote ref.': 'QT-JS-001', Due: 'Before works start' });
  });

  it('balance invoice: Due "On receipt", after the quote reference', async () => {
    await renderPdf(page, await buildBalanceInvoice(page, balanceInvoiceFixture, fakeTenant, fakeBrand));
    const meta = await headerMeta();
    expect(meta.Due).toBe('On receipt');
    expect(Object.keys(meta)).toEqual(['Date', 'Invoice no.', 'Quote ref.', 'Due']);
  });

  it('full and stage invoices carry the same Due line', async () => {
    await renderPdf(page, await buildFullInvoice(page, fullInvoiceFixture, fakeTenant, fakeBrand));
    expect((await headerMeta()).Due).toBe('On receipt');
    await renderPdf(page, await buildStageInvoice(page, stageInvoiceFixture, fakeTenant, fakeBrand));
    const meta = await headerMeta();
    expect(Object.keys(meta)).toEqual(['Date', 'Invoice no.', 'Quote ref.', 'Due', 'Stage']);
    expect(meta.Due).toBe('On receipt');
  });

  it('with no Due wording supplied the row is left out, not invented', async () => {
    const { dueLabel: _gone, ...noDue } = balanceInvoiceFixture;
    await renderPdf(page, await buildBalanceInvoice(page, noDue, fakeTenant, fakeBrand));
    expect(Object.keys(await headerMeta())).toEqual(['Date', 'Invoice no.', 'Quote ref.']);
    const { dueLabel: _g2, ...noDueFull } = fullInvoiceFixture;
    await renderPdf(page, await buildFullInvoice(page, noDueFull, fakeTenant, fakeBrand));
    expect(Object.keys(await headerMeta())).toEqual(['Date', 'Invoice no.', 'Quote ref.']);
  });
});

describe('the scope on page 1', () => {
  it('is set in the compact size on every invoice, as on the owner\'s real invoices', async () => {
    await renderPdf(page, await buildDepositInvoice(page, depositInvoiceFixture, fakeTenant, fakeBrand));
    expect(await page.$$eval('.page:first-of-type .scope-compact .scope-sec', (e) => e.length)).toBe(3);
    const col = await page.$eval('.scope-compact .scope-sec', (e) => getComputedStyle(e).gridTemplateColumns.split(' ')[0]);
    // 9mm number column (34px at 96 dpi)
    expect(Math.round(parseFloat(col))).toBe(34);
  });

  it('a real-size scope (7 sections, 17 bullets) keeps a deposit invoice to two pages', async () => {
    const pdf = await renderPdf(page, await buildDepositInvoice(page, longDepositInvoiceFixture, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(2);
    expect(await page.$$eval('.page:first-of-type .scope-sec', (e) => e.length)).toBe(7);
  });

  it('a real-size scope keeps a balance invoice to two pages', async () => {
    const pdf = await renderPdf(page, await buildBalanceInvoice(page, longBalanceInvoiceFixture, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(2);
    expect(await page.$$eval('.page:first-of-type .scope-sec', (e) => e.length)).toBe(7);
  });

  it('the same scope would not fit two pages at the standard size (so the compact size is what makes it fit)', async () => {
    const doc = await buildDepositInvoice(page, longDepositInvoiceFixture, fakeTenant, fakeBrand);
    const standard = doc.replace(/class="scope-compact"/g, 'class="scope-standard"');
    await page.setContent(standard);
    await page.emulatePrint();
    const overflow = await page.$$eval('.page:first-of-type', (p) => p[0].scrollHeight > p[0].clientHeight + 1);
    const [first] = await page.$$eval('.page:first-of-type .scope-sec', (e) => e.map((x) => x.getBoundingClientRect().bottom));
    expect(overflow || first > 0).toBe(true);
    const lastBottom = await page.$$eval('.page:first-of-type .scope-sec', (e) => Math.max(...e.map((x) => x.getBoundingClientRect().bottom)));
    const footerTop = await page.$eval('.page:first-of-type .rf', (e) => e.getBoundingClientRect().top);
    expect(lastBottom).toBeGreaterThan(footerTop);
  });

  it('a scope too long even for the compact size carries on to extra pages and the footers still count them', async () => {
    const extra = longDepositInvoiceFixture.scope.map((s) => ({ ...s, heading: `${s.heading} (more)` }));
    const input = { ...longDepositInvoiceFixture, scope: [...longDepositInvoiceFixture.scope, ...extra, ...extra] };
    const pdf = await renderPdf(page, await buildDepositInvoice(page, input, fakeTenant, fakeBrand));
    const count = await page.$$eval('.page', (p) => p.length);
    expect(count).toBeGreaterThan(2);
    expect(pdfPages(pdf)).toBe(count);
  });
});

describe('the guarantee band', () => {
  const bandPage = () => page.$$eval('.page', (ps) => ps.findIndex((p) => p.querySelector('.gband') !== null) + 1);

  it('sits at the foot of page 1 when the scope is short enough, and not twice', async () => {
    await renderPdf(page, await buildDepositInvoice(page, depositInvoiceFixture, fakeTenant, fakeBrand));
    expect(await bandPage()).toBe(1);
    expect(await page.$$eval('.gband', (e) => e.length)).toBe(1);
  });

  it('moves to the payment page when page 1 is full', async () => {
    await renderPdf(page, await buildDepositInvoice(page, longDepositInvoiceFixture, fakeTenant, fakeBrand));
    expect(await bandPage()).toBe(2);
    expect(await page.$$eval('.gband', (e) => e.length)).toBe(1);
  });

  it('is on one page only for a balance invoice too', async () => {
    await renderPdf(page, await buildBalanceInvoice(page, balanceInvoiceFixture, fakeTenant, fakeBrand));
    expect(await page.$$eval('.gband', (e) => e.length)).toBe(1);
    await renderPdf(page, await buildBalanceInvoice(page, longBalanceInvoiceFixture, fakeTenant, fakeBrand));
    expect(await bandPage()).toBe(2);
  });
});

describe('the owner\'s wording on the money page', () => {
  it('rows read "30% Deposit – [job] as specified above" and "Balance payment – [job] as specified above"', async () => {
    await renderPdf(page, await buildDepositInvoice(page, depositInvoiceFixture, fakeTenant, fakeBrand));
    expect(await page.$$eval('table.px tbody td:first-child', (e) => e.map((x) => x.textContent))).toEqual(['30% Deposit – flat roof replacement as specified above']);
    await renderPdf(page, await buildBalanceInvoice(page, balanceInvoiceFixture, fakeTenant, fakeBrand));
    expect(await page.$$eval('table.px tbody td:first-child', (e) => e.map((x) => x.textContent))).toEqual(['Balance payment – flat roof replacement as specified above']);
  });

  it('the payment reference is the first line of the property address, as supplied', async () => {
    await renderPdf(page, await buildBalanceInvoice(page, balanceInvoiceFixture, fakeTenant, fakeBrand));
    const ref = await page.$$eval('.paycard .pg > div', (d) => d.map((x) => [x.querySelector('span')?.textContent, x.querySelector('b')?.textContent]).find(([k]) => k === 'Payment reference'));
    expect(ref).toEqual(['Payment reference', '123 Bromley Road']);
  });

  it('balance invoice: the box note and the terms say payment is due on receipt', async () => {
    await renderPdf(page, await buildBalanceInvoice(page, balanceInvoiceFixture, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).toContain('Payment is due upon receipt of this invoice');
    expect(t).toContain('Final balance invoice – 30% deposit already received (receipt RCP-JS-001-D), remaining balance due below.');
  });

  it('deposit invoice: the box says "Payable before works start · 30% deposit"', async () => {
    await renderPdf(page, await buildDepositInvoice(page, depositInvoiceFixture, fakeTenant, fakeBrand));
    expect(await page.$eval('.duebox .when', (e) => e.textContent)).toBe('Payable before works start · 30% deposit');
  });
});
