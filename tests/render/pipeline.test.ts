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

  it('guard rejects a child wider than the page', async () => {
    const doc = documentShell({
      title: 't',
      css,
      body: raw('<section class="page"><div class="body"><div style="width:400mm;white-space:nowrap">wide</div></div></section>'),
    });
    await expect(renderPdf(page, doc)).rejects.toBeInstanceOf(PageOverflowError);
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

  it('rejects when only the .body box overflows', async () => {
    const doc = documentShell({
      title: 't',
      css,
      body: raw('<section class="page"><div class="body"><div style="height:255mm"></div></div></section>'),
    });
    await expect(renderPdf(page, doc)).rejects.toBeInstanceOf(PageOverflowError);
  });

  it('accepts content just inside the .body box', async () => {
    const doc = documentShell({
      title: 't',
      css,
      body: raw('<section class="page"><div class="body"><div style="height:245mm"></div></div></section>'),
    });
    const pdf = await renderPdf(page, doc);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('route layer alone aborts remote requests (no CSP)', async () => {
    const failed: string[] = [];
    const onFail = (r: { url(): string }) => failed.push(r.url());
    page.on('requestfailed', onFail);
    await page.setContent('<!doctype html><img id="x" src="https://example.com/route.png">');
    await page.waitForFunction(() => (document.getElementById('x') as HTMLImageElement).complete);
    page.off('requestfailed', onFail);
    expect(failed).toContain('https://example.com/route.png');
  });

  it('CSP layer alone blocks inline script (route cannot see inline script)', async () => {
    const doc = documentShell({ title: 't', css, body: raw('<script>document.body.dataset.ran="1"</script>') });
    await page.setContent(doc);
    expect(await page.evaluate(() => document.body.dataset.ran)).toBeUndefined();
    const bare = await page.context().newPage();
    await bare.setContent('<!doctype html><body><script>document.body.dataset.ran="1"</script>');
    expect(await bare.evaluate(() => document.body.dataset.ran)).toBe('1');
    await bare.close();
  });

  it('measures fragment heights', async () => {
    const [a, b] = await measureFragments(page, css, 178, [raw('<div style="height:100px"></div>'), raw('<div style="height:250px"></div>')]);
    expect(a).toBeCloseTo(100, 0);
    expect(b).toBeCloseTo(250, 0);
  });
});
