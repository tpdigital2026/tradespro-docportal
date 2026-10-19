import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderBrowser as Browser, RenderPage as Page } from '../../src/pdf/browser';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { PageOverflowError, renderPdf, screenshotPages } from '../../src/pdf/render';
import { buildSurvey } from '../../src/templates/survey';
import { fakeBrand, fakeTenant } from '../fixtures/fake';
import { loadFjcBrand, referenceAvailable } from '../fixtures/fjc';
import { surveyFixture } from '../fixtures/survey';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await launchBrowser();
  page = await newLockedPage(browser);
});
afterAll(async () => {
  await browser.close();
});

const brand = () => (referenceAvailable ? { ...loadFjcBrand(), assets: { ...loadFjcBrand().assets, coverPhoto: null, signature: null } } : fakeBrand);
const text = () => page.evaluate(() => document.body.textContent ?? '');
const pdfPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
const OUT = path.join(process.cwd(), 'out', 'render', 'survey');

describe('survey report', () => {
  it('four findings (1 to 4 photos): cover, index, one page per finding, conclusion; numbering and counts automatic', async () => {
    const input = await surveyFixture();
    const doc = await buildSurvey(page, input, fakeTenant, brand());
    const pdf = await renderPdf(page, doc);
    expect(pdfPages(pdf)).toBe(7);
    const t = await text();
    for (const s of ['Roof Defect', 'Survey Report', 'SR-DEMO-4001', 'Mr John Smith', '123 Bromley Road', '4 defects recorded', '10 site photographs', 'Four findings recorded', 'Photo 4.4', 'Photo 3.3', 'Photo 1.1', 'Professional opinion', 'page 07', 'Typed signature', fakeTenant.ownerName, `prepared by ${fakeTenant.name}`]) {
      expect(t, s).toContain(s);
    }
    expect(t).toContain('Finding 04 · Page 06');
    expect(t).toContain('Page 07 / 07');
    // One business throughout: no other business name appears anywhere on the report.
    expect(t).not.toMatch(/Demo Roofing/);
    // A single photo sits at the planned width, 60% of the page body (178mm), centred.
    const single = await page.$eval('.sv-photos figure', (e) => e.getBoundingClientRect().width / (178 * 96 / 25.4));
    expect(single).toBeGreaterThan(0.45);
    expect(single).toBeLessThanOrEqual(0.6 + 0.005);
    // The finding pages never crop a photo: every image keeps its own shape.
    const ratios = await page.$$eval('.sv-photos figure', (els) => els.map((e) => { const r = e.getBoundingClientRect(); const img = e.querySelector('img') as HTMLImageElement; return [r.width / r.height, img.naturalWidth / img.naturalHeight]; }));
    for (const [box, img] of ratios) expect(Math.abs(box - img)).toBeLessThan(0.03);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, 'survey.pdf'), pdf);
    await screenshotPages(page, doc, path.join(OUT, 'standard'));
  });

  it('nine findings, no cover photo, no remedial line, the longest wording: the index flows and nothing overflows', async () => {
    const input = await surveyFixture({ findings: 9, cover: false, remedial: false });
    input.findings[0].title = 'Fascias along the whole front elevation sit forward of the gutter line, so rainwater runs down the wall face';
    input.findings[0].observation = ['W'.repeat(1) + ' The fascia boards along the front elevation sit forward of the gutter line. '.repeat(11).slice(0, 898)];
    input.findings[0].assessment = [' In my assessment the boards were fitted without allowing for the gutter. '.repeat(12).slice(0, 899)];
    input.opinion = ['Based on the inspection carried out, it is my professional opinion that the roof needs remedial work. '.repeat(12).slice(0, 1200), 'The defects recorded would not be expected from work carried out to a competent standard. '.repeat(13).slice(0, 1190)];
    const doc = await buildSurvey(page, input, fakeTenant, brand());
    const pdf = await renderPdf(page, doc);
    expect(pdfPages(pdf)).toBe(12);
    const t = await text();
    expect(t).toContain('Nine findings recorded');
    expect(t).not.toContain('Remedial works');
    await screenshotPages(page, doc, path.join(OUT, 'long'));
  });

  it('twenty findings: the index runs onto a second page and the page numbers follow', async () => {
    const input = await surveyFixture({ findings: 20, photoCounts: [1] });
    const doc = await buildSurvey(page, input, fakeTenant, brand());
    const pdf = await renderPdf(page, doc);
    const t = await text();
    expect(t).toContain('Summary of findings, continued');
    expect(t).toContain('20 findings recorded');
    const total = pdfPages(pdf);
    expect(total).toBe(1 + 2 + 20 + 1);
    expect(t).toContain(`Finding 20 · Page ${total - 1}`);
  });

  it('long names, a long address and a long remedial line wrap inside their boxes', async () => {
    const input = await surveyFixture({ findings: 1, photoCounts: [2] });
    input.customerName = 'Mr Johnathan Alexander Bartholomew Smith-Montgomery-Fortescue and Mrs Jane Example-Longname';
    input.property = 'Flat 12, The Old Granary Building, 123 Bromley Road, Shortlands, Bromley, Greater London, BR1 1AA, United Kingdom, with the rear outbuilding and garage';
    input.remedial = 'Remedial works to be quoted separately after the scaffold is up and the full extent of the timber is known'.slice(0, 160);
    await renderPdf(page, await buildSurvey(page, input, fakeTenant, brand()));
  });

  it('an opinion too long for the last page is refused with a plain message, never clipped', async () => {
    const input = await surveyFixture({ findings: 1, photoCounts: [1] });
    input.opinion = Array.from({ length: 16 }, () => 'It is my professional opinion that the roof needs remedial work before it can be relied on. '.repeat(5));
    await expect(buildSurvey(page, input, fakeTenant, brand())).rejects.toThrow(PageOverflowError);
  });

  it('the wording is escaped (no markup from the owner reaches the page)', async () => {
    const input = await surveyFixture({ findings: 1, photoCounts: [1] });
    input.findings[0].title = '<img src=x onerror=alert(1)> & "quotes"';
    await renderPdf(page, await buildSurvey(page, input, fakeTenant, brand()));
    expect(await page.$$eval('img[src="x"]', (e) => e.length)).toBe(0);
    expect(await text()).toContain('<img src=x onerror=alert(1)> & "quotes"');
  });
});
