import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderBrowser as Browser, RenderPage as Page } from '../../src/pdf/browser';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { renderPdf } from '../../src/pdf/render';
import { mapDocument } from '../../src/lib/documents/map';
import { buildQuotation, type QuotationInput } from '../../src/templates/quotation';
import { buildBalanceInvoice, buildDepositInvoice } from '../../src/templates/invoice';
import { buildReceipt } from '../../src/templates/receipt';
import { buildGuarantee } from '../../src/templates/guarantee';
import { depositReceiptFixture } from '../fixtures/receipts';
import { guaranteeFixture } from '../fixtures/guarantee';
import { companyLine } from '../../src/templates/parts';
import { fjcTenant, loadFjcBrand } from '../fixtures/fjc';
import { caseOf, KIND_BUSINESS, KIND_CASES, kindFacts, scopeOf, type KindName } from '../fixtures/quote-kinds';
import { balanceInvoiceFixture, depositInvoiceFixture } from '../fixtures/invoices';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Brand } from '../../src/themes/types';
import { templateById } from '../../src/templates/registry';
import { applyTemplate, loadTemplate, renderedSlots, sha256, slotProblems, TemplateLockError, verifyRenderedImages } from '../../src/lib/documents/template-lock';

// The owner's quotations, kind by kind, from the locked templates (src/templates/library/fjc): no reference folder needed.
let browser: Browser;
let page: Page;
const brand = loadFjcBrand();
beforeAll(async () => {
  browser = await launchBrowser();
  page = await newLockedPage(browser);
});
afterAll(async () => {
  await browser.close();
});

const pdfPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

function inputFor(name: KindName, scope?: { heading: string; steps: string[] }[], ref?: string): QuotationInput {
  const r = mapDocument(kindFacts(caseOf(name), { scope, ref }), KIND_BUSINESS);
  if (!r.ok) throw new Error(r.missing.join('; '));
  return r.mapped.input as QuotationInput;
}

/** What every page shows: running header (label, ref), footer (tagline, company, page n / total), scope numbers and continued eyebrows. */
const pageFacts = () =>
  page.$$eval('.page', (ps) =>
    ps.map((p) => ({
      header: p.querySelector('.rh') ? { label: p.querySelector('.rh .eyebrow')?.textContent ?? '', ref: p.querySelector('.rh .ref')?.textContent ?? '', logo: (p.querySelector('.rh img') as HTMLImageElement | null)?.src.startsWith('data:image/png') ?? false } : null,
      footer: p.querySelector('.rf') ? { tag: p.querySelector('.rf .tag')?.textContent ?? '', all: p.querySelector('.rf')?.textContent ?? '', pg: p.querySelector('.rf .pg')?.textContent ?? '', top: Math.round(p.querySelector('.rf')!.getBoundingClientRect().top - p.getBoundingClientRect().top) } : null,
      eyebrow: p.querySelector('.body > .eyebrow, .body > span.eyebrow')?.textContent ?? '',
      numbers: [...p.querySelectorAll('.scope-sec .n')].map((n) => Number(n.textContent)),
      sections: [...p.querySelectorAll('.scope-sec')].map((s) => ({ h: s.querySelector('h4')?.textContent ?? '', lis: s.querySelectorAll('li').length })),
      hero: p.querySelector('.cover-hero') !== null,
    })),
  );

/** The brand a document is drawn with: its locked template's images when it has one (as prepareLoaded does). */
function brandFor(input: { template?: string }): Brand {
  if (!input.template) return brand;
  const t = loadTemplate(input.template);
  if (!t.ok) throw new Error(t.problems.join('; '));
  return applyTemplate(brand, t);
}

async function draw(input: QuotationInput): Promise<Buffer> {
  const pdf = await renderPdf(page, await buildQuotation(page, input, fjcTenant, brandFor(input)));
  if (input.template) await verifyRenderedImages(page, input.template);
  return pdf;
}

describe('each kind of job is drawn from its locked template', () => {
  for (const c of KIND_CASES) {
    it(`${c.name}: template images by hash, eyebrow, strip and page count`, async () => {
      const input = inputFor(c.name);
      expect(input.template ?? null).toBe(c.expect.template);
      const pdf = await draw(input);
      const n = pdfPages(pdf);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
      expect(await page.$$eval('.page', (p) => p.length)).toBe(n);

      const cover = await page.$eval('.cover-hero', (h) => ({ eyebrow: h.querySelector('.eyebrow')?.textContent ?? '', strip: [...h.querySelectorAll('.strip > div')].map((d) => d.firstChild?.textContent ?? '') }));
      expect(cover.eyebrow).toBe(c.expect.eyebrow);
      const slots = await renderedSlots(page);
      if (c.expect.template) {
        const tpl = templateById(c.expect.template)!;
        // Every image slot loaded and shows exactly the template's file (by sha256), and nothing else is on the pages.
        expect(slotProblems(tpl, slots)).toEqual([]);
        const hashOf = (slot: string) => slots.filter((x) => x.slot === slot).map((x) => sha256(Buffer.from(x.src.split(',')[1], 'base64')));
        expect(hashOf('cover')).toEqual([tpl.images.find((i) => i.slot === 'cover')!.sha256]);
        expect(slots.filter((x) => x.slot.startsWith('diagram-')).map((x) => x.slot)).toEqual(c.expect.diagrams);
        expect(cover.strip).toEqual(c.name === 'commercial' ? ['Client', 'Quote reference', 'Quote date', 'Total inc. VAT'] : ['Quote reference', 'Quote date', 'Total inc. VAT']);
        if (c.expect.diagrams.length === 1) {
          const text = await page.$eval('.diag', (d) => d.textContent ?? '');
          expect(text).toContain(c.expect.diagrams[0] === 'diagram-flat' ? 'Every layer has a job to do' : 'Every part has a job to do');
          if (c.expect.diagrams[0] === 'diagram-flat') expect(text).toContain('Example flat roofing build-up. The exact system is as set out in the scope of works.');
        }
        expect(await page.$$eval('.card.gold', (e) => e.map((x) => x.textContent))).toEqual(c.guaranteeYears ? [`${c.guaranteeYears} YearsGuarantee`] : []);
      } else {
        // Parked (fascias): the plain layout of before, with the business's own cover photo if it has one.
        expect(slots.filter((x) => x.slot.startsWith('diagram-'))).toEqual([]);
        expect(cover.strip).toEqual(['Quote reference', 'Quote date', 'Total inc. VAT']);
      }
      // The signature line prints the stored picture.
      expect(await page.$$eval('.sign img', (e) => e.length)).toBe(1);
    });
  }

  it('prints the reference exactly as given, revision suffix and all', async () => {
    await draw(inputFor('flat', undefined, 'QT-AB-012-3'));
    const refs = await page.$$eval('.cover-hero .strip b, .rh .ref, .kv .v', (e) => e.map((x) => x.textContent));
    expect(refs.filter((r) => r === 'QT-AB-012-3').length).toBeGreaterThanOrEqual(1 + 3 + 1);
  });

  it('a template without its image cannot be drawn: never a quiet document without it', async () => {
    const input = inputFor('tiled');
    const t = loadTemplate(input.template!);
    if (!t.ok) throw new Error();
    const { cover: _drop, ...rest } = t.images;
    const broken = { ...brand, assets: { ...brand.assets, templateImages: rest } };
    await expect(buildQuotation(page, input, fjcTenant, broken)).rejects.toThrow(/no image in slot cover/);
  });

  it('a swapped image on the page is caught after the render', async () => {
    const input = inputFor('flat');
    const t = loadTemplate(input.template!);
    if (!t.ok) throw new Error();
    const other = loadTemplate('fjc/quotation/tiled-roof');
    if (!other.ok) throw new Error();
    const swapped = applyTemplate(brand, { ...t, images: { ...t.images, cover: other.images.cover } });
    await renderPdf(page, await buildQuotation(page, input, fjcTenant, swapped));
    await expect(verifyRenderedImages(page, input.template!)).rejects.toThrow(TemplateLockError);
  });
});

/** Every page as a PNG with all text made transparent: what is left is the template (images, rules, panels, colours). */
async function maskedPages(): Promise<Buffer[]> {
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}';
    document.head.appendChild(st);
  });
  return page.screenshotAll('.page');
}

async function halfSize(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  // A fixed size (the A4 page at 96 dpi): the two engines' element screenshots can differ by a pixel or two in height.
  const { data, info } = await sharp(png).resize(794, 1123, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Share of pixels that differ by more than 24 in any channel, and the mean difference. */
function diff(a: { data: Buffer }, b: { data: Buffer }): { share: number; mean: number } {
  let big = 0;
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 3) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    sum += d;
    if (d > 24) big += 1;
  }
  const n = a.data.length / 3;
  return { share: big / n, mean: sum / n };
}

const GOLDEN = path.join(process.cwd(), 'tests', 'golden', 'templates');

describe('the pages match the template with the data masked out', () => {
  for (const name of ['flat', 'tiled', 'tiled-and-flat', 'commercial'] as KindName[]) {
    it(`${name}: two different customers give the same masked pages, and both match the committed template`, async () => {
      const a = inputFor(name);
      await draw(a);
      const pagesA = await maskedPages();
      const b: QuotationInput = { ...a, ref: 'QT-AB-987-2', customer: { name: 'Mrs Jane Brown', email: 'jane.brown@example.org', phone: '07700 900456' }, property: '45 Sample Lane, Bromley, BR1 4XY' };
      await draw(b);
      const pagesB = await maskedPages();
      expect(pagesB.length).toBe(pagesA.length);
      const goldenDir = path.join(GOLDEN, a.template!.replaceAll('/', '_'));
      if (process.env.UPDATE_GOLDEN === '1') mkdirSync(goldenDir, { recursive: true });
      for (let i = 0; i < pagesA.length; i++) {
        const ha = await halfSize(pagesA[i]);
        const hb = await halfSize(pagesB[i]);
        expect(diff(ha, hb).share, `page ${i + 1}, A against B`).toBeLessThan(0.002);
        const file = path.join(goldenDir, `page-${i + 1}.png`);
        if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, await sharp(ha.data, { raw: { width: ha.width, height: ha.height, channels: 3 } }).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer());
        expect(existsSync(file), `golden ${file} (run with UPDATE_GOLDEN=1 to make it)`).toBe(true);
        const g = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        expect([g.info.width, g.info.height]).toEqual([ha.width, ha.height]);
        const d = diff(ha, { data: g.data });
        // The committed template was drawn by one engine; the other resamples pictures very slightly differently. A swapped
        // or missing picture changes far more than this (a cover photo alone is about a third of page 1).
        expect(d.share, `page ${i + 1} against the committed template`).toBeLessThan(0.03);
        expect(d.mean, `page ${i + 1} against the committed template`).toBeLessThan(2);
      }
    });
  }
});

/** 5, 15, 30 and 60 bullets over 2 to 8 sections, and 30 bullets of about 290 characters over 2 sections. */
const SCOPES: { label: string; bullets: number; sections: number; long?: boolean }[] = [
  { label: '5 bullets / 2 sections', bullets: 5, sections: 2 },
  { label: '15 bullets / 4 sections', bullets: 15, sections: 4 },
  { label: '30 bullets / 6 sections', bullets: 30, sections: 6 },
  { label: '60 bullets / 8 sections', bullets: 60, sections: 8 },
  { label: '30 long bullets / 2 sections', bullets: 30, sections: 2, long: true },
];

describe('long scopes carry on to pages with the same header and footer', () => {
  for (const name of ['tiled', 'flat', 'fascia', 'commercial'] as KindName[]) {
    for (const sc of SCOPES) {
      it(`${name}, ${sc.label}`, async () => {
        const input = inputFor(name, scopeOf(sc.bullets, sc.sections, sc.long));
        // renderPdf fails on any clipped or overflowing content, on every page.
        const pdf = await draw(input);
        const facts = await pageFacts();
        const total = facts.length;
        expect(pdfPages(pdf)).toBe(total);
        expect(total).toBeGreaterThanOrEqual(3);
        expect(total).toBeLessThanOrEqual(8);

        // The cover has its hero and no running header; every other page has the header and the footer, in the same place.
        expect(facts[0].hero).toBe(true);
        expect(facts[0].header).toBeNull();
        const tops = new Set<number>();
        facts.forEach((f, i) => {
          expect(f.footer?.tag).toBe(fjcTenant.tagline);
          expect(f.footer?.all).toContain(companyLine(fjcTenant));
          expect(f.footer?.pg).toBe(`Page ${String(i + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`);
          tops.add(f.footer!.top);
          if (i > 0) expect(f.header).toEqual({ label: input.coverTitle, ref: input.ref, logo: true });
        });
        expect(tops.size).toBe(1);

        // Numbering carries on across pages and never restarts; a section split between pages keeps its number.
        const numbers = facts.flatMap((f) => f.numbers);
        expect(numbers[0]).toBe(1);
        numbers.forEach((n, i) => i > 0 && expect(n - numbers[i - 1]).toBeGreaterThanOrEqual(0));
        numbers.forEach((n, i) => i > 0 && expect(n - numbers[i - 1]).toBeLessThanOrEqual(1));
        expect(numbers[numbers.length - 1]).toBe(sc.sections);
        // Every heading has at least one bullet under it on the same page, and every bullet is printed once.
        const secs = facts.flatMap((f) => f.sections);
        secs.forEach((s) => expect(s.lis).toBeGreaterThan(0));
        expect(secs.reduce((a, s) => a + s.lis, 0)).toBe(sc.bullets);

        // Pages after the first scope page are headed "Scope of works, continued".
        const scopePages = facts.map((f, i) => (f.numbers.length ? i : -1)).filter((i) => i >= 0);
        scopePages.slice(1).forEach((i) => expect(facts[i].eyebrow).toBe('Scope of works, continued'));
        // The contents strip agrees with the pages.
        const toc = await page.$$eval('.toc > div', (rows) => rows.map((r) => [r.querySelector('.l')?.textContent ?? '', Number((r.querySelector('.p')?.textContent ?? '').replace(/\D/g, ''))] as [string, number]));
        expect(toc.find(([l]) => l === 'Scope of works')?.[1]).toBe(scopePages[0] + 1);
        expect(toc[toc.length - 1][1]).toBe(total);
      });
    }
  }
});

describe('invoices with a very long scope', () => {
  it('set the scope compact, then carry on to pages with the running header and footer instead of clipping', async () => {
    const scope = scopeOf(60, 8, true).map((s) => ({ heading: s.heading, bullets: s.steps }));
    const pdf = await renderPdf(page, await buildDepositInvoice(page, { ...depositInvoiceFixture, scope }, fjcTenant, brand));
    const facts = await pageFacts();
    expect(pdfPages(pdf)).toBe(facts.length);
    expect(facts.length).toBeGreaterThan(2);
    facts.forEach((f, i) => {
      expect(f.footer?.pg).toBe(`Page ${String(i + 1).padStart(2, '0')} / ${String(facts.length).padStart(2, '0')}`);
      if (i > 0) expect(f.header?.ref).toBe(depositInvoiceFixture.invoiceNo);
    });
    expect(await page.$$eval('.scope-compact .scope-sec', (e) => e.length)).toBeGreaterThan(0);
    const numbers = facts.flatMap((f) => f.numbers);
    numbers.forEach((n, i) => i > 0 && expect(n - numbers[i - 1]).toBeGreaterThanOrEqual(0));
    expect(numbers[numbers.length - 1]).toBe(8);
    expect(facts.flatMap((f) => f.sections).reduce((a, s) => a + s.lis, 0)).toBe(60);
  });
});

describe('the documents that follow a quote use the matching template: logo and navy header, no photo', () => {
  const docs: [string, () => Promise<string>][] = [
    ['fjc/deposit-invoice/flat-roof', async () => buildDepositInvoice(page, { ...depositInvoiceFixture, template: 'fjc/deposit-invoice/flat-roof' }, fjcTenant, brandFor({ template: 'fjc/deposit-invoice/flat-roof' }))],
    ['fjc/balance-invoice/tiled-roof', async () => buildBalanceInvoice(page, { ...balanceInvoiceFixture, template: 'fjc/balance-invoice/tiled-roof' }, fjcTenant, brandFor({ template: 'fjc/balance-invoice/tiled-roof' }))],
    ['fjc/receipt/commercial-roofing', async () => buildReceipt({ ...depositReceiptFixture, template: 'fjc/receipt/commercial-roofing' }, fjcTenant, brandFor({ template: 'fjc/receipt/commercial-roofing' }))],
    ['fjc/guarantee/flat-roof', async () => buildGuarantee({ ...guaranteeFixture, template: 'fjc/guarantee/flat-roof' }, fjcTenant, brandFor({ template: 'fjc/guarantee/flat-roof' }))],
  ];
  for (const [id, build] of docs) {
    it(id, async () => {
      await renderPdf(page, await build());
      await verifyRenderedImages(page, id);
      expect(await page.$$eval('.cover-hero, [data-slot="cover"], [data-slot^="diagram"]', (e) => e.length)).toBe(0);
      // As on the owner's originals (FJC_09 to FJC_14): only the certificate carries the signature.
      expect(await page.$$eval('.sign img', (e) => e.length)).toBe(id.includes('guarantee') ? 1 : 0);
    });
  }
});
