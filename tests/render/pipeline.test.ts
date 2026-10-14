import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { raw } from '../../src/lib/html';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { documentShell } from '../../src/pdf/document';
import { measureFragments } from '../../src/pdf/measure';
import { PageOverflowError, renderPdf } from '../../src/pdf/render';

const css = '.page{width:210mm;height:297mm;position:relative;overflow:hidden}.body{position:absolute;top:27mm;left:16mm;right:16mm;bottom:19mm}';
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchBrowser();
  page = await newLockedPage(browser);
});
afterAll(async () => {
  await browser.close();
});

describe('pdf pipeline', () => {
  it('produces a PDF', async () => {
    const doc = documentShell({ title: 't', css, body: raw('<section class="page"><div class="body">Hi</div></section>') });
    const pdf = await renderPdf(page, doc);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('does not run scripts in the document', async () => {
    const doc = documentShell({
      title: 't',
      css,
      body: raw('<section class="page"><div class="body"></div></section><script>document.body.dataset.ran="1"</script>'),
    });
    await page.setContent(doc);
    expect(await page.evaluate(() => document.body.dataset.ran)).toBeUndefined();
  });

  it('does not load remote images', async () => {
    const doc = documentShell({
      title: 't',
      css,
      body: raw('<img id="x" src="https://example.com/x.png"><section class="page"><div class="body"></div></section>'),
    });
    await page.setContent(doc);
    expect(await page.evaluate(() => (document.getElementById('x') as HTMLImageElement).naturalWidth)).toBe(0);
  });

  it('rejects a page whose content overflows', async () => {
    const doc = documentShell({
      title: 't',
      css,
      body: raw('<section class="page"><div class="body"><div style="height:400mm"></div></div></section>'),
    });
    await expect(renderPdf(page, doc)).rejects.toBeInstanceOf(PageOverflowError);
  });

  it('measures fragment heights', async () => {
    const [a, b] = await measureFragments(page, css, 178, [raw('<div style="height:100px"></div>'), raw('<div style="height:250px"></div>')]);
    expect(a).toBeCloseTo(100, 0);
    expect(b).toBeCloseTo(250, 0);
  });
});
