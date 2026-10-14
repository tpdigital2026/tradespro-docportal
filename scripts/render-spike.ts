import { mkdirSync, writeFileSync } from 'node:fs';
import { launchBrowser, newLockedPage } from '../src/pdf/browser';
import { renderPdf, screenshotPages } from '../src/pdf/render';
import { buildGuarantee } from '../src/templates/guarantee';
import { buildBalanceInvoice, buildDepositInvoice } from '../src/templates/invoice';
import { buildQuotation } from '../src/templates/quotation';
import { buildReceipt } from '../src/templates/receipt';
import { fjcTenant, loadFjcBrand } from '../tests/fixtures/fjc';
import { guaranteeFixture } from '../tests/fixtures/guarantee';
import { balanceInvoiceFixture, depositInvoiceFixture } from '../tests/fixtures/invoices';
import { quotationFixture } from '../tests/fixtures/quotation';
import { depositReceiptFixture, finalReceiptFixture } from '../tests/fixtures/receipts';

async function main() {
  const brand = loadFjcBrand();
  const browser = await launchBrowser();
  try {
    const page = await newLockedPage(browser);
    const docs: [string, () => Promise<string> | string][] = [
      ['quotation', () => buildQuotation(page, quotationFixture, fjcTenant, brand)],
      ['deposit-invoice', () => buildDepositInvoice(page, depositInvoiceFixture, fjcTenant, brand)],
      ['balance-invoice', () => buildBalanceInvoice(page, balanceInvoiceFixture, fjcTenant, brand)],
      ['receipt-deposit', () => buildReceipt(depositReceiptFixture, fjcTenant, brand)],
      ['receipt-paid-in-full', () => buildReceipt(finalReceiptFixture, fjcTenant, brand)],
      ['guarantee', () => buildGuarantee(guaranteeFixture, fjcTenant, brand)],
    ];
    for (const [name, build] of docs) {
      const dir = `out/${name}`;
      mkdirSync(dir, { recursive: true });
      const doc = await build();
      writeFileSync(`${dir}/${name}.pdf`, await renderPdf(page, doc));
      const files = await screenshotPages(page, doc, dir);
      console.log(`${name}: ${files.length} page(s)`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
