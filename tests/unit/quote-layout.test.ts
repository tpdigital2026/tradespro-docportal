import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FJC_WORDING } from '../../src/db/wording';
import { mapDocument } from '../../src/lib/documents/map';
import { coverEyebrow, guaranteeBandText, quoteShape, specCardsWithGuarantee, templateVariant } from '../../src/lib/documents/quote-layout';
import { applyTemplate, libraryDir, loadTemplate, slotProblems, templateOf } from '../../src/lib/documents/template-lock';
import { LIBRARIES, templateById, templateFor, VARIANTS } from '../../src/templates/registry';
import { mapGuarantee } from '../../src/lib/guarantee/map';
import type { QuotationInput } from '../../src/templates/quotation';
import { fakeBrand } from '../fixtures/fake';
import { KIND_BUSINESS, KIND_CASES, kindFacts } from '../fixtures/quote-kinds';

describe('quoteShape: the kind of job, from the job type and the cover', () => {
  it('maps each job type', () => {
    expect(quoteShape('tiled_roof', 'Re-Roof Quotation', '')).toEqual({ kind: 'tiled', commercial: false });
    expect(quoteShape('flat_roof', 'Flat Roof Installation Quotation', '')).toEqual({ kind: 'flat', commercial: false });
    expect(quoteShape('fascia', 'Fascia Replacement Quotation', '')).toEqual({ kind: 'fascia', commercial: false });
    expect(quoteShape('other', 'Chimney Repair Quotation', '')).toEqual({ kind: 'other', commercial: false });
    expect(quoteShape('', 'Quotation', '')).toEqual({ kind: 'other', commercial: false });
  });

  it('a cover naming both a tiled and a flat roof is a mixed job, except for fascias', () => {
    expect(quoteShape('tiled_roof', 'Roof Replacement Quotation', 'Tiled roof area and three flat roof areas').kind).toBe('mixed');
    expect(quoteShape('flat_roof', 'Flat and Pitched Roof Quotation', '').kind).toBe('mixed');
    expect(quoteShape('fascia', 'Fascias to the tiled and flat roofs', '').kind).toBe('fascia');
    expect(quoteShape('flat_roof', 'Flat Roof Replacement Quotation', 'New joists and deck').kind).toBe('flat');
  });

  it('a cover title starting "Commercial" is a commercial job', () => {
    expect(quoteShape('tiled_roof', 'Commercial Re-Roof Quotation', '').commercial).toBe(true);
    expect(quoteShape('tiled_roof', 'Re-Roof Quotation for a commercial unit', '').commercial).toBe(false);
  });
});

describe('templateVariant: which template family a job uses', () => {
  it('flat, tiled, tiled and flat, and commercial tiled roofs; fascias and other jobs are parked (no template)', () => {
    expect(templateVariant({ kind: 'flat', commercial: false })).toBe('flat-roof');
    expect(templateVariant({ kind: 'tiled', commercial: false })).toBe('tiled-roof');
    expect(templateVariant({ kind: 'mixed', commercial: false })).toBe('tiled-and-flat-roof');
    expect(templateVariant({ kind: 'tiled', commercial: true })).toBe('commercial-roofing');
    expect(templateVariant({ kind: 'fascia', commercial: false })).toBeNull();
    expect(templateVariant({ kind: 'other', commercial: false })).toBeNull();
  });
});

describe('the template registry', () => {
  const fjc = LIBRARIES.fjc;

  it('has a quotation, four invoices and a receipt for each of the four kinds of job, and two guarantee certificates', () => {
    for (const v of VARIANTS) {
      for (const t of ['quotation', 'deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage', 'receipt'] as const) expect(templateFor('fjc', t, v)?.id).toBe(`fjc/${t}/${v}`);
    }
    expect(templateFor('fjc', 'guarantee', 'flat-roof')?.id).toBe('fjc/guarantee/flat-roof');
    expect(templateFor('fjc', 'guarantee', 'tiled-roof')?.id).toBe('fjc/guarantee/tiled-roof');
    expect(templateFor('fjc', 'quotation', null)).toBeNull();
    expect(templateFor('other-business', 'quotation', 'flat-roof')).toBeNull();
    expect(templateFor(null, 'quotation', 'flat-roof')).toBeNull();
    expect(fjc.templates.map((t) => t.id)).toEqual([...new Set(fjc.templates.map((t) => t.id))]);
  });

  it('every image file in the manifest exists in the template library and has the manifest sha256', () => {
    for (const t of fjc.templates) {
      for (const img of t.images) {
        const file = path.join(libraryDir('fjc'), img.file);
        expect(existsSync(file), `${t.id} ${img.slot}`).toBe(true);
        expect(createHash('sha256').update(readFileSync(file)).digest('hex'), `${t.id} ${img.slot}`).toBe(img.sha256);
      }
    }
  });

  it('each quotation stores its own photos in its own folder (no shared pool), and follow-on documents have no photos', () => {
    for (const t of fjc.templates) {
      const photos = t.images.filter((i) => !i.slot.startsWith('logo-'));
      if (t.documentType === 'quotation') {
        expect(photos.map((i) => i.slot)).toContain('cover');
        for (const p of photos) expect(p.file.startsWith(`quotation-${t.variant}/`)).toBe(true);
      } else expect(photos).toEqual([]);
    }
  });

  it('the quotation pictures match the owner\'s reference quotations', () => {
    const src = (id: string, slot: string) => templateById(id)?.images.find((i) => i.slot === slot)?.source ?? '';
    expect(src('fjc/quotation/flat-roof', 'cover')).toMatch(/ph_flat\.jpg$/);
    expect(src('fjc/quotation/flat-roof', 'diagram-flat')).toMatch(/diag_flat\.jpg$/);
    expect(src('fjc/quotation/tiled-roof', 'cover')).toMatch(/ph_tiled\.jpg$/);
    expect(src('fjc/quotation/tiled-roof', 'diagram-pitched')).toMatch(/diag_pitched\.jpg$/);
    expect(src('fjc/quotation/tiled-and-flat-roof', 'cover')).toMatch(/ph_tiled\.jpg$/);
    expect(src('fjc/quotation/tiled-and-flat-roof', 'diagram-flat')).toMatch(/diag_flat\.jpg$/);
    expect(src('fjc/quotation/commercial-roofing', 'cover')).toMatch(/ph_roofers\.jpg$/);
    expect(src('fjc/quotation/commercial-roofing', 'diagram-pitched')).toMatch(/diag_pitched\.jpg$/);
  });
});

describe('the template lock', () => {
  it('loads a template\'s images by slot, checked by hash', () => {
    const t = loadTemplate('fjc/quotation/flat-roof');
    if (!t.ok) throw new Error(t.problems.join());
    expect(Object.keys(t.images).sort()).toEqual(['cover', 'diagram-flat', 'logo-colour', 'logo-white']);
    expect(t.images.cover.startsWith('data:image/jpeg;base64,')).toBe(true);
    const b = applyTemplate(fakeBrand, t);
    expect(b.assets.logoWhite).toBe(t.images['logo-white']);
    expect(b.assets.templateImages).toBe(t.images);
    expect(b.assets.signature).toBe(fakeBrand.assets.signature);
  });

  it('blocks a template whose file is missing, empty or changed', () => {
    const real = (f: string) => readFileSync(f);
    const missing = loadTemplate('fjc/quotation/tiled-roof', (f) => {
      if (f.endsWith('cover.jpg')) throw new Error('ENOENT');
      return real(f);
    });
    expect(missing).toMatchObject({ ok: false, problems: ['cover: quotation-tiled-roof/cover.jpg is missing'] });
    const changed = loadTemplate('fjc/quotation/tiled-roof', (f) => (f.endsWith('diagram-pitched.jpg') ? Buffer.concat([real(f), Buffer.from([0])]) : real(f)));
    expect(changed.ok).toBe(false);
    expect(!changed.ok && changed.problems[0]).toMatch(/^diagram-pitched: .* does not match the manifest/);
    const empty = loadTemplate('fjc/quotation/tiled-roof', (f) => (f.endsWith('cover.jpg') ? Buffer.alloc(0) : real(f)));
    expect(!empty.ok && empty.problems).toEqual(['cover: quotation-tiled-roof/cover.jpg is empty']);
    expect(loadTemplate('fjc/quotation/fascia')).toMatchObject({ ok: false, problems: ['no such template in the registry'] });
  });

  it('checks the images on rendered pages against the manifest', () => {
    const t = templateById('fjc/receipt/flat-roof')!;
    const ok = loadTemplate(t.id);
    if (!ok.ok) throw new Error();
    const good = [{ slot: 'logo-white', src: ok.images['logo-white'], loaded: true }];
    expect(slotProblems(t, good)).toEqual([]);
    expect(slotProblems(t, [{ ...good[0], loaded: false }])).toEqual(['logo-white: the image did not load']);
    expect(slotProblems(t, [{ ...good[0], src: 'data:image/png;base64,AAAA' }])).toEqual(["logo-white: the image shown is not the template's file"]);
    expect(slotProblems(t, [{ ...good[0], src: 'https://example.com/x.png' }])).toEqual(['logo-white: the image is not embedded']);
    expect(slotProblems(t, [])).toEqual(['logo-white: the template image is not on the pages']);
    expect(slotProblems(t, [...good, { slot: 'cover', src: ok.images['logo-white'], loaded: true }])).toEqual(['an image in slot "cover" is not part of the template']);
  });
});

describe('the wording around the content', () => {
  it('cover eyebrow: sector and title, with Commercial moved to the sector', () => {
    const sector = { residential: 'Residential', commercial: 'Commercial' };
    expect(coverEyebrow('Re-Roof Quotation', { kind: 'tiled', commercial: false }, sector)).toBe('Residential · Re-Roof Quotation');
    expect(coverEyebrow('Commercial Re-Roof Quotation', { kind: 'tiled', commercial: true }, sector)).toBe('Commercial · Re-Roof Quotation');
  });

  it('the guarantee card is gold and last, only when the job has a guarantee', () => {
    const cards = [{ big: '3-Layer Felt', label: 'Roofing system' }];
    expect(specCardsWithGuarantee(cards, 20)).toEqual([{ big: '3-Layer Felt', label: 'Roofing system', accent: false }, { big: '20 Years', label: 'Guarantee', accent: true }]);
    expect(specCardsWithGuarantee(cards, null)).toEqual([{ big: '3-Layer Felt', label: 'Roofing system', accent: false }]);
    expect(specCardsWithGuarantee([{ big: '20 Years', label: 'Guarantee' }], 20)).toEqual([{ big: '20 Years', label: 'Guarantee', accent: true }]);
    expect(specCardsWithGuarantee([{ big: '20 Years', label: 'Guarantee', accent: true }], null)[0].accent).toBe(false);
  });

  it('the guarantee band fills in the years and the business', () => {
    const band = templateById('fjc/quotation/tiled-roof')!.wording!.guaranteeBand;
    expect(guaranteeBandText(25, 'FJC Roofing Ltd', band)).toBe('The roofing system specified above has been selected specifically for this project, and allows FJC Roofing Ltd to provide a 25-year guarantee on completion of the works.');
  });
});

describe('mapQuotation for each kind of job', () => {
  for (const c of KIND_CASES) {
    it(`${c.name}: template, diagrams, eyebrow, headings`, () => {
      const r = mapDocument(kindFacts(c), KIND_BUSINESS);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const q = r.mapped.input as QuotationInput;
      expect(templateOf(q) ?? null).toBe(c.expect.template);
      expect(q.coverEyebrow).toBe(c.expect.eyebrow);
      const diagrams = !q.diagram ? [] : q.diagram.layout === 'pair' ? q.diagram.items.map((i) => i.image) : [q.diagram.image];
      expect(diagrams).toEqual(c.expect.diagrams);
      expect(q.ref).toBe('QT-JS-001-1');
      if (c.expect.template) {
        expect(q.stripClient).toBe(c.name === 'commercial');
        expect(q.scopeHeading).toBe(c.name === 'commercial' ? 'What we will do, stage by stage' : 'What we will do, step by step');
        expect(q.specCards.some((x) => x.accent)).toBe(c.guaranteeYears !== null);
        expect(q.lines[0].kind).toBe('Work');
      } else {
        // Parked (fascias): exactly the plain layout of before.
        expect(q.specEyebrow).toBe('Specification');
        expect(q.specHeading).toBe('At a glance');
        expect(q.scopeHeading).toBe('What we will do');
        expect(q.stripClient).toBeUndefined();
        expect(q.lines[0].kind).toBe('Works');
      }
    });
  }

  it('a business without a template library keeps the plain layout', () => {
    const r = mapDocument(kindFacts(KIND_CASES[1]), { ...KIND_BUSINESS, slug: null });
    if (!r.ok) throw new Error(r.missing.join());
    const q = r.mapped.input as QuotationInput;
    expect(templateOf(q)).toBeUndefined();
    expect(q.diagram).toBeNull();
    expect(q.coverEyebrow).toBe('Flat roof · Quotation');
  });

  it('a guarantee certificate uses the template for its roof', () => {
    const facts = (roofType: string) => ({ number: 'GC-JS-001-G1', jobReference: 'QT-JS-001', customerName: 'Mr John Smith', values: { roofType, roofOther: roofType === 'other' ? 'Porch roof' : '', years: '20', address: '123 Bromley Road', completedOn: '2026-10-01', linkedQuote: '' } });
    const map = (roof: string) => mapGuarantee(facts(roof) as never, { ...KIND_BUSINESS, wording: FJC_WORDING }, '2026-10-20');
    const id = (roof: string) => {
      const r = map(roof);
      return r.ok ? (templateOf(r.input) ?? null) : `missing: ${r.missing.join()}`;
    };
    expect(id('flat')).toBe('fjc/guarantee/flat-roof');
    expect(id('tiled')).toBe('fjc/guarantee/tiled-roof');
    expect(id('dormer')).toBeNull();
  });
});
