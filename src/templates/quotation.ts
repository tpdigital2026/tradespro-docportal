import type { RenderPage as Page } from '../pdf/engine';
import { html, raw } from '../lib/html';
import { computeTotals, formatGBP, type MoneyLine } from '../lib/money';
import { documentShell } from '../pdf/document';
import type { Brand, Tenant } from '../themes/types';
import { documentCss } from './css';
import * as P from './parts';
import { measureFragments, PX_PER_MM } from '../pdf/measure';
import { flowScope } from './scope-flow';

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
  /** null when the business has no build-up diagram for this kind of job. */
  diagram: { eyebrow: string; heading: string; body: string; caption: string } | null;
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
  };
  let flow = await flowScope(flowOptions);

  const d = input.diagram && brand.assets.diagram ? input.diagram : null;
  // The specification page only exists when there is something to put on it.
  const hasSpec = input.specCards.length > 0 || d !== null || input.callout !== null;
  const specEyebrow = input.specEyebrow ?? 'Roof specification';

  // 3. Specification (only when there is something to show).
  const cols = input.specCards.length <= 3 ? 'c3' : 'c4';
  const cards = input.specCards.length ? html`<div class="cards ${cols}">${input.specCards.map((c) => html`<div class="card${c.accent ? ' gold' : ''}"><div class="big">${c.big}</div><div class="lab">${c.label}</div></div>`)}</div>` : null;
  const diagram = d ? html`<div style="display:grid;grid-template-columns:1.25fr 1fr;gap:8mm;margin-top:9mm;align-items:center"><div style="background:var(--paper);padding:2mm"><img src="${brand.assets.diagram}" alt="${d.heading}" style="width:100%;display:block"></div><div><span class="eyebrow">${d.eyebrow}</span><h3 style="margin-top:1.5mm">${d.heading}</h3><div class="rule"></div><p>${d.body}</p><p class="small">${d.caption}</p></div></div>` : null;
  const specInner = hasSpec
    ? html`<span class="eyebrow">${specEyebrow}</span><h2>${input.specHeading}</h2><div class="rule"></div>${cards}${diagram}${input.callout ? html`<div class="callout" style="margin-top:${cards || diagram ? '10mm' : '2mm'}"><span class="eyebrow">${input.callout.label}</span>${input.callout.text}</div>` : null}`
    : null;

  // A short scope shares the specification page, as the owner's real short quotes do. It must fit whole under the specification.
  let combined = false;
  if (specInner && d === null && flow.groups.length === 1) {
    const [specPx] = await measureFragments(page, css, BODY_WIDTH_MM, [specInner]);
    const fit = await flowScope({ ...flowOptions, firstAreaMm: BODY_MM - specPx / PX_PER_MM - SPEC_GAP_MM });
    if (fit.groups.length === 1) {
      flow = fit;
      combined = true;
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
  const cover = html`<section class="page">${P.coverHero(tenant, brand, {
    eyebrow: input.coverEyebrow,
    title: input.coverTitle,
    sub: input.coverSub,
    strip: [
      ['Quote reference', input.ref],
      ['Quote date', input.dateLabel],
      [showVat ? 'Total inc. VAT' : 'Total', formatGBP(totals.grossPence)],
    ],
  })}<div style="padding:9mm 16mm 0"><div class="details">${details.map(([k, v]) => P.kv(k, v, k === 'Validity'))}</div><div style="margin-top:7mm;display:grid;grid-template-columns:44mm 1fr;gap:8mm"><div><span class="eyebrow">Introduction</span><h3 style="margin-top:1.5mm">Your quotation</h3><div class="rule"></div></div><p class="lede">${input.introText}</p></div></div>${P.toc(tocEntries)}${footer(1)}</section>`;

  const spec = specInner && !combined ? P.page(specInner, header, footer(2)) : null;

  // 4. Scope pages.
  const scopePages = groups.map((g, gi) => {
    const lead = gi === 0 ? headFirst : headRest;
    const scope = html`${lead}<div>${g.map((idx) => items[idx])}</div>`;
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
