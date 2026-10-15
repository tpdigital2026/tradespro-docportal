import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderBrowser as Browser, RenderPage as Page } from '../../src/pdf/browser';
import { html } from '../../src/lib/html';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { PaginationError } from '../../src/pdf/paginate';
import { documentCss } from '../../src/templates/css';
import { scopeSection } from '../../src/templates/parts';
import { flowScope } from '../../src/templates/scope-flow';
import { fakeBrand } from '../fixtures/fake';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await launchBrowser();
  page = await newLockedPage(browser);
});
afterAll(async () => {
  await browser.close();
});

const css = () => documentCss(fakeBrand);
const sec = (n: number) => scopeSection(n, { heading: `Section ${n}`, bullets: ['One short bullet.', 'Another short bullet.'] });
const heads = { headFirst: html`<h2>First</h2>`, headRest: html`<h2>Rest</h2>` };

describe('flowScope', () => {
  it('keeps a short scope on one page', async () => {
    const r = await flowScope({ page, css: css(), widthMm: 178, firstAreaMm: 200, restAreaMm: 250, ...heads, sections: [1, 2, 3].map(sec) });
    expect(r.groups).toEqual([[0, 1, 2]]);
    expect(r.items).toHaveLength(3);
  });

  it('spills onto later pages in order using the rest area', async () => {
    const sections = Array.from({ length: 12 }, (_, i) => sec(i + 1));
    const r = await flowScope({ page, css: css(), widthMm: 178, firstAreaMm: 60, restAreaMm: 100, ...heads, sections });
    expect(r.groups.length).toBeGreaterThan(1);
    expect(r.groups.flat()).toEqual(sections.map((_, i) => i));
  });

  it('places trailing items after the sections, on the last page', async () => {
    const band = html`<div class="gband"><div class="yr">20</div><div>Guarantee</div></div>`;
    const r = await flowScope({ page, css: css(), widthMm: 178, firstAreaMm: 200, restAreaMm: 250, ...heads, sections: [sec(1)], trailing: [band] });
    expect(r.items).toHaveLength(2);
    expect(r.groups.at(-1)?.at(-1)).toBe(1);
  });

  it('throws when one section cannot fit a page', async () => {
    await expect(
      flowScope({ page, css: css(), widthMm: 178, firstAreaMm: 20, restAreaMm: 20, ...heads, sections: [sec(1)] }),
    ).rejects.toBeInstanceOf(PaginationError);
  });
});
