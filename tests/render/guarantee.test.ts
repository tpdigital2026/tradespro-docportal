import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderBrowser as Browser, RenderPage as Page } from '../../src/pdf/browser';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { PageOverflowError, renderPdf } from '../../src/pdf/render';
import { buildGuarantee } from '../../src/templates/guarantee';
import { fakeBrand, fakeTenant } from '../fixtures/fake';
import { guaranteeFixture } from '../fixtures/guarantee';

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

describe('guarantee certificate unbroken token', () => {
  it('long address: rejects or wraps without running off the page', async () => {
    let result = 'wrapped';
    try {
      await renderPdf(page, buildGuarantee({ ...guaranteeFixture, address: 'W'.repeat(80) }, fakeTenant, fakeBrand));
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
    process.stderr.write(`unbroken guarantee address: ${result}\n`);
  });
});

describe('guarantee certificate', () => {
  it('renders one page with the supplied wording', async () => {
    const pdf = await renderPdf(page, buildGuarantee(guaranteeFixture, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(1);
    const t = await text();
    for (const s of [
      'Certificate of',
      'Guarantee',
      'This certifies that the dormer flat roof installed at',
      '123 Bromley Road, Bromley, BR2 8BG',
      'was installed by',
      'INSTALLATION COMPLETED · 06/10/2026',
      guaranteeFixture.statement,
      'Ben Cunningham',
      'COMPANY NO. 13855379',
    ]) {
      expect(t).toContain(s);
    }
    expect(t.toUpperCase()).toContain('WE CANNOT BE HELD RESPONSIBLE FOR MISUSE OF OUR PRODUCTS BY THE CUSTOMER');
  });

  it('prints what the owner’s reference certificate prints and nothing more: no certificate number, website, email and company number bottom right', async () => {
    await renderPdf(page, buildGuarantee({ ...guaranteeFixture, workDescription: 'tiled roof', years: 25 }, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).not.toContain('CERTIFICATE NO');
    expect(t).not.toContain('GC-JS-001');
    for (const s of [fakeTenant.web, fakeTenant.email, `COMPANY NO. ${fakeTenant.companyNo}`, 'Authorised signature · Director', '25 Year Guarantee']) expect(t).toContain(s);
    expect(await page.$$eval('.page', (e) => e.length)).toBe(1);
  });

  it('leaves out the website, email, company number and tagline lines a business does not have', async () => {
    await renderPdf(page, buildGuarantee(guaranteeFixture, { ...fakeTenant, web: '', email: '', companyNo: '', tagline: '' }, fakeBrand));
    const t = await text();
    expect(t).not.toContain('COMPANY NO');
    expect(await page.$$eval('.mono div', (e) => e.filter((x) => (x.textContent ?? '').trim() === '').length)).toBe(0);
  });

  const sealFont = () => page.$eval('svg textPath', (el) => ({ text: el.textContent ?? '', px: parseFloat(getComputedStyle(el.parentElement as Element).fontSize) }));

  it('seal text names the business and the years at full size for a normal name', async () => {
    await renderPdf(page, buildGuarantee(guaranteeFixture, fakeTenant, fakeBrand));
    const seal = await sealFont();
    expect(seal.text).toContain('FJC ROOFING LTD');
    expect(seal.text).toContain('20 YEAR GUARANTEE');
    expect(seal.px).toBe(10);
  });

  it('shrinks the seal text for a long business name so it cannot overlap', async () => {
    const tenant = { ...fakeTenant, name: 'Bromley Kitchens and Bathrooms Roofing Ltd '.padEnd(60, 'x') };
    expect(tenant.name).toHaveLength(60);
    await renderPdf(page, buildGuarantee(guaranteeFixture, tenant, fakeBrand));
    const { px } = await sealFont();
    expect(px).toBeLessThan(10);
    expect(px).toBeGreaterThanOrEqual(6);
  });

  it('fails closed when the business name cannot fit the seal', () => {
    const tenant = { ...fakeTenant, name: 'N'.repeat(200) };
    expect(() => buildGuarantee(guaranteeFixture, tenant, fakeBrand)).toThrow(/too long/);
  });

  it('leaves the disclaimer line out when none is given', async () => {
    await renderPdf(page, buildGuarantee({ ...guaranteeFixture, disclaimerLine: null }, fakeTenant, fakeBrand));
    expect((await text()).toUpperCase()).not.toContain('MISUSE');
  });

  it('escapes input text, including inside the seal', async () => {
    const tenant = { ...fakeTenant, name: 'A <b>&</b> Co' };
    const input = { ...guaranteeFixture, address: '<img src=x onerror=alert(1)>' };
    await renderPdf(page, buildGuarantee(input, tenant, fakeBrand));
    expect(await page.$$eval('img[onerror]', (e) => e.length)).toBe(0);
    // The seal label is the uppercased tenant name, escaped: literal text, not markup.
    expect((await sealFont()).text).toContain('A <B>&</B> CO');
    // The HTML parser hoists a stray <b> out of <svg>, so count every <b> in the page.
    // The template emits exactly one: the "installed by" business name, whose content is escaped text.
    expect(await page.$$eval('b', (e) => e.length)).toBe(1);
  });

  it('fails closed when the content does not fit the frame', async () => {
    const input = { ...guaranteeFixture, address: 'A very long address line '.repeat(60) };
    await expect(renderPdf(page, buildGuarantee(input, fakeTenant, fakeBrand))).rejects.toBeInstanceOf(PageOverflowError);
  });
});

/**
 * The ring text must fill the circle exactly once with even spacing and never overlap itself, whatever the name length
 * (the owner's reference certificate printed its ring text twice over where it wrapped). Measured on the drawn glyphs:
 * the angle of each letter's start about the centre must rise steadily, the steps must be equal (monospace type), and the
 * last letter must end before the first one starts.
 */
describe('seal ring text', () => {
  const ring = () =>
    page.$eval('svg textPath', (tp) => {
      const t = tp as unknown as SVGTextContentElement;
      const n = t.getNumberOfChars();
      const angle = (p: DOMPoint) => (Math.atan2(p.y - 100, p.x - 100) * 180) / Math.PI;
      const starts: number[] = [];
      for (let i = 0; i < n; i += 1) starts.push(angle(t.getStartPositionOfChar(i)));
      const unwrap = (a: number[]) => {
        const out = [a[0]];
        for (let i = 1; i < a.length; i += 1) {
          let v = a[i];
          while (v < out[i - 1] - 180) v += 360;
          while (v > out[i - 1] + 180) v -= 360;
          out.push(v);
        }
        return out;
      };
      const us = unwrap(starts);
      // Each letter's end is its own start plus the (small, forward) angle it covers.
      const ends = us.map((a, i) => a + ((((angle(t.getEndPositionOfChar(i)) - starts[i]) % 360) + 360) % 360));
      return { text: t.textContent ?? '', starts: us, ends };
    });

  const names = ['AB Ltd', 'FJC Roofing Ltd', 'Bromley Kitchens and Bathrooms Roofing Ltd'];
  for (const name of names) {
    it(`fills the circle once, evenly, with no overlap: ${name}`, async () => {
      await renderPdf(page, buildGuarantee({ ...guaranteeFixture, years: 25 }, { ...fakeTenant, name }, fakeBrand));
      const r = await ring();
      // The business name appears once, then the years once.
      expect(r.text.split(name.toUpperCase()).length - 1).toBe(1);
      expect(r.text.split('YEAR GUARANTEE').length - 1).toBe(1);
      const steps = r.starts.slice(1).map((a, i) => a - r.starts[i]);
      expect(Math.min(...steps)).toBeGreaterThan(0);
      const spread = (Math.max(...steps) - Math.min(...steps)) / Math.max(...steps);
      expect(spread).toBeLessThan(0.05);
      // Round once: from the first letter to the end of the last is no more than a full turn, and the last letter ends before the first begins.
      expect(r.ends[r.ends.length - 1] - r.starts[0]).toBeLessThanOrEqual(360 + 0.5);
      expect(r.ends[r.ends.length - 1]).toBeLessThanOrEqual(r.starts[0] + 360 + 0.5);
      for (let i = 0; i < r.starts.length; i += 1) expect(r.ends[i]).toBeGreaterThan(r.starts[i]);
      for (let i = 1; i < r.starts.length; i += 1) expect(r.starts[i]).toBeGreaterThanOrEqual(r.ends[i - 1] - 0.2);
    });
  }
});
