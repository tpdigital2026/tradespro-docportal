import type { RenderPage as Page } from '../pdf/engine';
import { html, raw, type Raw } from '../lib/html';
import { computeTotals, formatGBP, type MoneyLine } from '../lib/money';
import { documentShell } from '../pdf/document';
import type { Brand, Tenant } from '../themes/types';
import { documentCss } from './css';
import * as P from './parts';
import { measureFragments, PX_PER_MM } from '../pdf/measure';
import { flowScope } from './scope-flow';
import { PaginationError } from '../pdf/paginate';

export interface QuotationInput {
  ref: string;
  dateLabel: string;
  validityDays: number;
  customer: { name: string; email: string; phone: string };
  property: string;
  coverEyebrow: string;
  coverTitle: string;
  coverSub: string;
  introText: string;
  /** Eyebrow over the specification page. Defaults to "Roof specification" (the FJC reference). */
  specEyebrow?: string;
  specHeading: string;
  specCards: { big: string; label: string; accent?: boolean }[];
  /** null when the business has no build-up diagram (or no wording for it) for this kind of job. */
  diagram: QuoteDiagram | null;
  /**
   * The locked template this quotation is drawn from (src/templates/registry.ts). Its images come only from
   * brand.assets.templateImages (cover in slot "cover", diagrams by their slot), and a missing one is an error. Absent:
   * the plain layout, with brand.assets.coverPhoto and brand.assets.diagram when the business has them.
   */
  template?: string;
  /** Commercial quotations name the client first in the cover strip, as the owner's do. */
  stripClient?: boolean;
  callout: { label: string; text: string } | null;
  scopeHeading: string;
  scope: P.ScopeSection[];
  guarantee: { years: number; text: string } | null;
  vatRateBp: number;
  lines: MoneyLine[];
  /** How the total is paid (from the payment plan), shown under the total. Empty or absent: not shown. */
  paymentSchedule?: [string, string][];
  terms: string;
  /** Empty: the "Important information" block is left out. */
  disclaimer: string;
}

/**
 * The build-up diagram section. single: the picture beside its eyebrow, heading, paragraphs and caption. pair: two
 * pictures side by side, each with a label, and one caption under both. image names the template's image slot; absent,
 * brand.assets.diagram (the plain layout, where a picture the business does not have leaves the section out).
 */
export type QuoteDiagram =
  | { layout: 'single'; image?: string; eyebrow: string; heading: string; body: string[]; caption: string }
  | { layout: 'pair'; items: { image: string; label: string }[]; caption: string };

const BODY_MM = 297 - 27 - 19; // .body: top 27mm, bottom 19mm in base.css
const BODY_WIDTH_MM = 210 - 2 * 16;
/** Space between the specification and the scope when they share a page. */
const SPEC_GAP_MM = 9;

export async function buildQuotation(page: Page, input: QuotationInput, tenant: Tenant, brand: Brand): Promise<string> {
  const css = documentCss(brand);
  const totals = computeTotals(input.lines, input.vatRateBp);
  const showVat = input.lines.some((l) => l.vatApplies);
  if (input.scope.length === 0) throw new Error('Quotation scope must contain at least one section');
  const preparedBy = `${tenant.ownerName}, ${tenant.name}`;

  // 1. Measure the scope so it can be split across pages without clipping.
  const sectionFrags = input.scope.map((s, i) => P.scopeSection(i + 1, s));
  const band = input.guarantee ? P.guaranteeBand(input.guarantee.years, input.guarantee.text) : null;
  const headFirst = html`<span class="eyebrow">Scope of works</span><h2>${input.scopeHeading}</h2><div class="rule"></div>`;
  const headRest = html`<span class="eyebrow">Scope of works, continued</span><div style="height:3mm"></div>`;
  const flowOptions = {
    page,
    css,
    widthMm: BODY_WIDTH_MM,
    firstAreaMm: BODY_MM,
    restAreaMm: BODY_MM,
    headFirst,
    headRest,
    sections: sectionFrags,
    trailing: band ? [band] : [],
    split: { scope: input.scope, build: P.scopeSection },
  };
  let flow = await flowScope(flowOptions);

  const diagram = diagramBlock(input.diagram, brand, input.template);
  // The specification page only exists when there is something to put on it.
  const hasSpec = input.specCards.length > 0 || diagram !== null || input.callout !== null;
  const specEyebrow = input.specEyebrow ?? 'Roof specification';

  // 3. Specification (only when there is something to show). More than four key figures go on a second row.
  const cardRows = input.specCards.length > 4 ? [input.specCards.slice(0, 4), input.specCards.slice(4)] : [input.specCards];
  const cards = input.specCards.length
    ? html`${cardRows.map((row, i) => html`<div class="cards ${row.length <= 3 ? 'c3' : 'c4'}"${i > 0 ? raw(' style="margin-top:3.5mm"') : null}>${row.map((c) => html`<div class="card${c.accent ? ' gold' : ''}"><div class="big">${c.big}</div><div class="lab">${c.label}</div></div>`)}</div>`)}`
    : null;
  const specInner = hasSpec
    ? html`<span class="eyebrow">${specEyebrow}</span><h2>${input.specHeading}</h2><div class="rule"></div>${cards}${diagram}${input.callout ? html`<div class="callout" style="margin-top:${cards || diagram ? '10mm' : '2mm'}"><span class="eyebrow">${input.callout.label}</span>${input.callout.text}</div>` : null}`
    : null;

  // A short scope shares the specification page, as the owner's real short quotes do. It must fit whole under the specification.
  let combined = false;
  if (specInner && diagram === null && flow.groups.length === 1) {
    const [specPx] = await measureFragments(page, css, BODY_WIDTH_MM, [specInner]);
    // A first section taller than the space under the specification cannot share the page (paginate refuses it).
    const fit = await flowScope({ ...flowOptions, firstAreaMm: BODY_MM - specPx / PX_PER_MM - SPEC_GAP_MM }).catch((e) => {
      if (e instanceof PaginationError) return null;
      throw e;
    });
    if (fit && fit.groups.length === 1) {
      flow = fit;
      combined = true;
    }
  }
  // A scope a little too long for one page is set in the compact size when that keeps it on one page, as the owner's
  // eight-section re-roof quotation is; a scope that needs two pages either way keeps the normal size.
  let compact = false;
  if (input.template && !combined && flow.groups.length === 2) {
    const tight = await flowScope({ ...flowOptions, compact: true });
    if (tight.groups.length === 1) {
      flow = tight;
      compact = true;
    }
  }
  const { items, groups } = flow;
  const firstScopePage = hasSpec && !combined ? 3 : 2;
  const total = firstScopePage + groups.length;
  let guaranteePage: number | null = null;
  if (band) {
    const gi = groups.findIndex((g) => g.includes(items.length - 1));
    if (gi === -1) throw new Error('Guarantee band was not placed on any scope page');
    guaranteePage = firstScopePage + gi;
  }
  const header = P.runningHeader(tenant, brand, input.coverTitle, input.ref);
  const footer = (n: number) => P.runningFooter(tenant, n, total);

  // 2. Cover. A detail with no value on record is left out rather than shown blank.
  const details = (
    [
      ['Client', input.customer.name],
      ['Quote date', input.dateLabel],
      ['Property', input.property],
      ['Quote reference', input.ref],
      ['Contact email', input.customer.email],
      ['Prepared by', preparedBy],
      ['Contact number', input.customer.phone],
      ['Validity', `Valid for ${input.validityDays} days from the date above`],
    ] as [string, string][]
  ).filter(([, v]) => v.trim() !== '');
  const tocEntries: [string, number][] = hasSpec ? [[specEyebrow, 2], ['Scope of works', firstScopePage]] : [['Scope of works', firstScopePage]];
  if (guaranteePage !== null) tocEntries.push(['Guarantee', guaranteePage]);
  // Without a guarantee the last cell is split in two, as on the owner's real short quotes.
  if (guaranteePage !== null) tocEntries.push(['Pricing & terms', total]);
  else tocEntries.push(['Pricing', total], ['Terms', total]);
  const coverPhoto = input.template ? templateImage(brand, input.template, 'cover') : brand.assets.coverPhoto;
  const strip: [string, string][] = [
    ...(input.stripClient ? ([['Client', input.customer.name]] as [string, string][]) : []),
    ['Quote reference', input.ref],
    ['Quote date', input.dateLabel],
    [showVat ? 'Total inc. VAT' : 'Total', formatGBP(totals.grossPence)],
  ];
  const cover = html`<section class="page">${P.coverHero(tenant, { ...brand, assets: { ...brand.assets, coverPhoto } }, {
    eyebrow: input.coverEyebrow,
    title: input.coverTitle,
    sub: input.coverSub,
    strip,
  })}<div style="padding:9mm 16mm 0"><div class="details">${details.map(([k, v]) => P.kv(k, v, k === 'Validity'))}</div><div style="margin-top:7mm;display:grid;grid-template-columns:44mm 1fr;gap:8mm"><div><span class="eyebrow">Introduction</span><h3 style="margin-top:1.5mm">Your quotation</h3><div class="rule"></div></div><p class="lede">${input.introText}</p></div></div>${P.toc(tocEntries)}${footer(1)}</section>`;

  const spec = specInner && !combined ? P.page(specInner, header, footer(2)) : null;

  // 4. Scope pages.
  const scopePages = groups.map((g, gi) => {
    const lead = gi === 0 ? headFirst : headRest;
    const scope = html`${lead}<div${compact ? raw(' class="scope-compact"') : null}>${g.map((idx) => items[idx])}</div>`;
    const inner = combined && gi === 0 && specInner ? html`${specInner}<div style="margin-top:${SPEC_GAP_MM}mm">${scope}</div>` : scope;
    return P.page(inner, header, footer(firstScopePage + gi));
  });

  // 5. Pricing.
  const rateLabel = `${input.vatRateBp / 100}%`;
  const rows = totals.lines.map((l) => ({
    description: l.description,
    kind: l.kind,
    qty: String(l.qty),
    unit: formatGBP(l.unitNetPence),
    vat: l.vatApplies ? rateLabel : '0%',
    total: formatGBP(l.grossPence),
  }));
  const totalRows: [string, string][] = showVat
    ? [['Subtotal', formatGBP(totals.netPence)], [`VAT (${rateLabel})`, formatGBP(totals.vatPence)]]
    : [];
  const pricing = P.page(
    html`<span class="eyebrow">Pricing</span><h2>Your quotation</h2><div class="rule"></div>${P.priceTable(rows, showVat)}${P.totalsBlock(totalRows, 'Total', formatGBP(totals.grossPence), input.paymentSchedule ?? [])}<div class="terms" style="margin-top:10mm"><div class="t"><h5>Terms and conditions</h5><p>${input.terms}</p></div>${showVat && tenant.vatNo ? html`<div class="t"><h5>VAT registration number</h5><p class="mono">${tenant.vatNo}</p></div>` : null}</div><div style="margin-top:12mm"><span class="eyebrow">Prepared by</span><div style="margin-top:4mm">${P.signBlock(brand, tenant.ownerName, `${tenant.ownerTitle} · ${tenant.name}`, preparedBy, input.dateLabel)}</div></div>${input.disclaimer.trim() ? html`<div class="fine" data-reserved style="position:absolute;bottom:0;left:0;right:0"><b>Important information</b>${input.disclaimer}</div>` : null}`,
    header,
    footer(total),
  );

  const pages = [cover, ...(spec ? [spec] : []), ...scopePages, pricing];
  return documentShell({
    title: `${tenant.name} Quotation ${input.ref}`,
    css,
    body: raw(pages.map((p) => p.value).join('')),
  });
}

/** A locked template's image. Never left out quietly: a template without its image cannot be drawn. */
function templateImage(brand: Brand, template: string, slot: string): string {
  const uri = brand.assets.templateImages?.[slot];
  if (!uri) throw new Error(`Template ${template} has no image in slot ${slot}`);
  return uri;
}

function diagramBlock(d: QuoteDiagram | null, brand: Brand, template: string | undefined): Raw | null {
  if (!d) return null;
  const src = (key?: string) => (template && key ? templateImage(brand, template, key) : key === undefined ? brand.assets.diagram : null);
  if (d.layout === 'single') {
    const img = src(d.image);
    if (!img) return null;
    // The pitched roof picture is wider than the flat roof one, so it takes a little more of the row (as on the owner's quotations).
    const cols = d.image?.includes('pitched') ? '1.3fr 1fr' : '1.25fr 1fr';
    return html`<div class="diag" style="display:grid;grid-template-columns:${cols};gap:8mm;margin-top:9mm;align-items:center"><div style="background:var(--paper);padding:2mm"><img src="${img}" alt="${d.heading}"${d.image ? raw(` data-slot="${d.image}"`) : null} style="width:100%;display:block"></div><div><span class="eyebrow">${d.eyebrow}</span><h3 style="margin-top:1.5mm">${d.heading}</h3><div class="rule"></div>${d.body.map((p) => html`<p>${p}</p>`)}${d.caption ? html`<p class="small">${d.caption}</p>` : null}</div></div>`;
  }
  const items = d.items.flatMap((it) => {
    const img = src(it.image);
    return img ? [{ ...it, img }] : [];
  });
  if (items.length === 0) return null;
  return html`<div class="diag pair" style="margin-top:9mm"><div style="display:grid;grid-template-columns:repeat(${items.length},minmax(0,1fr));gap:6mm">${items.map((it) => html`<div><div style="background:var(--paper);height:62mm;display:flex;align-items:center;justify-content:center;padding:2mm"><img src="${it.img}" alt="${it.label}" data-slot="${it.image}" style="max-width:100%;max-height:100%;display:block"></div><span class="eyebrow" style="display:block;margin-top:3.5mm">${it.label}</span></div>`)}</div>${d.caption ? html`<p class="small" style="margin-top:4mm">${d.caption}</p>` : null}</div>`;
}
