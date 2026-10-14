import { mkdirSync, writeFileSync } from 'node:fs';
import { launchBrowser, newLockedPage } from '../src/pdf/browser';
import { renderPdf, screenshotPages } from '../src/pdf/render';
import { buildQuotation } from '../src/templates/quotation';
import { fjcTenant, loadFjcBrand } from '../tests/fixtures/fjc';
import { quotationFixture } from '../tests/fixtures/quotation';

async function main() {
  mkdirSync('out/quotation', { recursive: true });
  const browser = await launchBrowser();
  try {
    const page = await newLockedPage(browser);
    const doc = await buildQuotation(page, quotationFixture, fjcTenant, loadFjcBrand());
    writeFileSync('out/quotation/quotation.pdf', await renderPdf(page, doc));
    const files = await screenshotPages(page, doc, 'out/quotation');
    console.log('PDF: out/quotation/quotation.pdf');
    console.log(files.join('\n'));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
