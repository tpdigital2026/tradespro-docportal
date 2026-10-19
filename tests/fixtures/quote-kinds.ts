/**
 * Dummy quotes, one per kind of job the owner quotes for (tiled re-roof, flat roof, fascias (parked: no template yet),
 * tiled and flat, commercial),
 * shaped like his reference quotations but with made-up customers, addresses and figures. Used by the unit and render
 * tests of the quotation layout (src/lib/documents/quote-layout.ts).
 */
import { demoBusiness, demoIssuedJobs } from '../../src/lib/demo-data';
import type { DocumentFacts } from '../../src/lib/documents/map';
import { approvalHash, type ScopeFormValues } from '../../src/lib/scope/model';
import { normaliseQuote, type QuoteFormValues } from '../../src/lib/validation/quote';

export type KindName = 'tiled' | 'flat' | 'fascia' | 'tiled-and-flat' | 'commercial';

export interface KindCase {
  name: KindName;
  jobTypeKey: string;
  jobTypeLabel: string;
  guaranteeYears: number | null;
  title: string;
  sub: string;
  cards: [string, string][];
  note: string;
  /** The template it must be drawn from (null: parked, the plain layout), its diagram slots and its cover eyebrow. */
  expect: { template: string | null; diagrams: string[]; eyebrow: string };
}

export const KIND_CASES: KindCase[] = [
  {
    name: 'tiled',
    jobTypeKey: 'tiled_roof',
    jobTypeLabel: 'Tiled roof',
    guaranteeYears: 25,
    title: 'Re-Roof Quotation',
    sub: 'Complete tiled roof replacement, full scope of works and pricing',
    cards: [['55m²', 'Roof sizing'], ['Concrete', 'Roof tiles'], ['Dry Fix', 'Ridge & hip system']],
    note: 'Any broken joints on the guttering will be repaired, free of charge.',
    expect: { template: 'fjc/quotation/tiled-roof', diagrams: ['diagram-pitched'], eyebrow: 'Residential · Re-Roof Quotation' },
  },
  {
    name: 'flat',
    jobTypeKey: 'flat_roof',
    jobTypeLabel: 'Flat roof',
    guaranteeYears: 20,
    title: 'Flat Roof Installation Quotation',
    sub: 'Complete flat roof installation, full scope of works and pricing',
    cards: [['3-Layer Felt', 'Roofing system'], ['Code 4 Lead', 'Perimeter flashing']],
    note: 'Restricted roof access adds time to the works, as materials must be carried up by hand.',
    expect: { template: 'fjc/quotation/flat-roof', diagrams: ['diagram-flat'], eyebrow: 'Residential · Flat Roof Installation Quotation' },
  },
  {
    name: 'fascia',
    jobTypeKey: 'fascia',
    jobTypeLabel: 'Fascias and guttering',
    guaranteeYears: null,
    title: 'Fascia Replacement Quotation',
    sub: 'Full replacement fascias to the entire property, full scope of works and pricing',
    cards: [['18mm', 'Full replacement fascias'], ['White', 'Fascia finish'], ['Guttering', 'Re-installed'], ['Entire Property', 'Including the apex']],
    note: '',
    expect: { template: null, diagrams: [], eyebrow: 'Fascias and guttering · Quotation' },
  },
  {
    name: 'tiled-and-flat',
    jobTypeKey: 'tiled_roof',
    jobTypeLabel: 'Tiled roof',
    guaranteeYears: null,
    title: 'Roof Replacement Quotation',
    sub: 'Tiled roof area and three flat roof areas, full scope of works and pricing',
    cards: [['Plain Tiles', 'Inclined roof area'], ['2-Layer Felt', 'Three flat roof areas'], ['Code 4 Lead', 'Wall flashing']],
    note: 'A full inspection will be carried out on the deck. The price may increase if the deck needs attention.',
    expect: { template: 'fjc/quotation/tiled-and-flat-roof', diagrams: ['diagram-pitched', 'diagram-flat'], eyebrow: 'Residential · Roof Replacement Quotation' },
  },
  {
    name: 'commercial',
    jobTypeKey: 'tiled_roof',
    jobTypeLabel: 'Tiled roof',
    guaranteeYears: 25,
    title: 'Commercial Re-Roof Quotation',
    sub: 'Complete roof replacement, prepared following full roof survey',
    cards: [['345m²', 'Total roof area'], ['Concrete', 'Roof tiles'], ['Dry Fix', 'Hip & ridge system']],
    note: '',
    expect: { template: 'fjc/quotation/commercial-roofing', diagrams: ['diagram-pitched'], eyebrow: 'Commercial · Re-Roof Quotation' },
  },
];

export const caseOf = (name: KindName): KindCase => KIND_CASES.find((c) => c.name === name)!;

const STEPS = [
  'All waste will be taken away by our truck, keeping the site clear and tidy throughout the works.',
  'Protection will be laid to the floors and walls where needed.',
  'The existing roof covering will be removed in full.',
  'A full inspection of the deck will be carried out before the new roof is installed.',
  'All edging will be removed, ready for the new edge flashings.',
  'The new roof covering will be installed as specified, with all edging flashings.',
  'New lead flashing will be installed to the wall, encapsulating all flashings.',
  'All waste will be cleared from site at the end of each day.',
];
const HEADINGS = ['Site set-up', 'Strip-out & removal', 'Decking', 'Waterproofing', 'Ventilation & eaves', 'Battens & tiling', 'Lead flashing', 'Finishing off'];
/** A bullet of about 290 characters (the form allows 300). */
export const LONG_STEP =
  'A full inspection of the existing deck, joists and wall plates will be carried out once the old covering is off, and any boards or timbers found to be rotten, split or soft will be cut out and replaced with new treated timber of the same size, fixed to the joists before the new roof goes on.';

/** `bullets` steps spread evenly over `sections` headed sections. */
export function scopeOf(bullets: number, sections: number, long = false): { heading: string; steps: string[] }[] {
  const out = Array.from({ length: sections }, (_, i) => ({ heading: HEADINGS[i % HEADINGS.length], steps: [] as string[] }));
  for (let b = 0; b < bullets; b++) out[b % sections].steps.push(long ? LONG_STEP : STEPS[b % STEPS.length]);
  return out;
}

export const DUMMY_CUSTOMER = { name: 'Mr John Smith', addressLines: ['123 Bromley Road'], postcode: 'BR2 8BG', email: 'john.smith@example.com', phone: '07700 900123' };

/** The facts of one dummy quote, with approved wording. `ref` defaults to the owner's revision form. */
export function kindFacts(c: KindCase, opts: { scope?: { heading: string; steps: string[] }[]; ref?: string } = {}): DocumentFacts {
  const base = demoIssuedJobs[0].form;
  const sections = opts.scope ?? scopeOf(9, 4);
  const scope: ScopeFormValues = {
    ...base.scope,
    coverTitle: c.title,
    coverSub: c.sub,
    intro: 'FJC Roofing Ltd is pleased to present this quotation for the works at 123 Bromley Road. This document sets out the full scope of works, materials, and pricing for the project.',
    specCards: c.cards.map(([value, label]) => ({ value, label })),
    note: c.note,
    copy: { ...base.scope.copy!, sections },
  };
  scope.copy = { ...scope.copy!, approvalHash: approvalHash(scope) };
  const form: QuoteFormValues = { ...base, scope };
  const ref = opts.ref ?? 'QT-JS-001-1';
  return {
    type: 'quotation',
    number: ref,
    docDate: '2026-10-07',
    quoteNumber: ref,
    propertyAddress: '123 Bromley Road, Bromley, BR2 8BG',
    jobTypeKey: c.jobTypeKey,
    jobTypeLabel: c.jobTypeLabel,
    guaranteeYears: c.guaranteeYears,
    customer: c.name === 'commercial' ? { ...DUMMY_CUSTOMER, name: 'Joe Bloggs Ltd' } : DUMMY_CUSTOMER,
    quoteForm: form,
    plan: normaliseQuote(form, 'draft', 2000).input.plan,
    documents: [],
    payments: [],
    followOn: null,
    bank: null,
  };
}

export const KIND_BUSINESS = { ...demoBusiness, vatRateBp: 2000 };
