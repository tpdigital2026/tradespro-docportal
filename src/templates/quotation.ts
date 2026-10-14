import type { Page } from 'playwright-core';
import { html, raw, type Raw } from '../lib/html';
import { computeTotals, formatGBP, type MoneyLine } from '../lib/money';
import { fontFaceCss } from '../pdf/assets';
import { documentShell } from '../pdf/document';
import { measureFragments, PX_PER_MM } from '../pdf/measure';
import { paginate } from '../pdf/paginate';
import { loadBaseCss, themeVarsCss } from '../themes/theme';
import type { Brand, Tenant } from '../themes/types';
import * as P from './parts';

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
  specHeading: string;
  specCards: { big: string; label: string; accent?: boolean }[];
  diagram: { eyebrow: string; heading: string; body: string; caption: string };
  callout: { label: string; text: string } | null;
  scopeHeading: string;
  scope: P.ScopeSection[];
  guarantee: { years: number; text: string } | null;
  vatRateBp: number;
  lines: MoneyLine[];
  terms: string;
  disclaimer: string;
}

const BODY_MM = 297 - 27 - 19; // .body: top 27mm, bottom 19mm in base.css
const BODY_WIDTH_MM = 210 - 2 * 16;
const SAFETY_PX = 12;
// Each measured .scope-sec matches :first-of-type (no border); on the page every later one gains a 0.3mm top border.
const SECTION_BORDER_PX = 0.3 * PX_PER_MM;

export async function buildQuotation(page: Page, input: QuotationInput, tenant: Tenant, brand: Brand): Promise<string> {
  const css = [fontFaceCss(), loadBaseCss(), themeVarsCss(brand.colours)].join('\n');
  const totals = computeTotals(input.lines, input.vatRateBp);
  const showVat = input.lines.some((l) => l.vatApplies);
  if (input.scope.length === 0) throw new Error('Quotation scope must contain at least one section');
  const preparedBy = `${tenant.ownerName}, ${tenant.name}`;

  // 1. Measure the scope so it can be split across pages without clipping.
  const sectionFrags = input.scope.map((s, i) => P.scopeSection(i + 1, s));
  const band = input.guarantee ? P.guaranteeBand(input.guarantee.years, input.guarantee.text) : null;
  const items: Raw[] = band ? [...sectionFrags, band] : sectionFrags;
  const headFirst = html`<span class="eyebrow">Scope of works</span><h2>${input.scopeHeading}</h2><div class="rule"></div>`;
  const headRest = html`<span class="eyebrow">Scope of works, continued</span><div style="height:3mm"></div>`;
  const [hFirst, hRest, ...measured] = await measureFragments(page, css, BODY_WIDTH_MM, [headFirst, headRest, ...items]);
  const heights = measured.map((h, i) => (i < sectionFrags.length ? h + SECTION_BORDER_PX : h));
  const bodyPx = BODY_MM * PX_PER_MM;
  const groups = paginate(heights, { first: bodyPx - hFirst - SAFETY_PX, rest: bodyPx - hRest - SAFETY_PX });

  const total = 2 + groups.length + 1;
  const firstScopePage = 3;
  let guaranteePage: number | null = null;
  if (band) {
    const gi = groups.findIndex((g) => g.includes(items.length - 1));
    if (gi === -1) throw new Error('Guarantee band was not placed on any scope page');
    guaranteePage = firstScopePage + gi;
  }
  const header = P.runningHeader(tenant, brand, input.coverTitle, input.ref);
  const footer = (n: number) => P.runningFooter(tenant, n, total);

  // 2. Cover.
  const tocEntries: [string, number][] = [['Roof specification', 2], ['Scope of works', firstScopePage]];
  if (guaranteePage !== null) tocEntries.push(['Guarantee', guaranteePage]);
  tocEntries.push(['Pricing & terms', total]);
  const cover = html`<section class="page">${P.coverHero(tenant, brand, {
    eyebrow: input.coverEyebrow,
    title: input.coverTitle,
    sub: input.coverSub,
    strip: [
      ['Quote reference', input.ref],
      ['Quote date', input.dateLabel],
      [showVat ? 'Total inc. VAT' : 'Total', formatGBP(totals.grossPence)],
    ],
  })}<div style="padding:9mm 16mm 0"><div class="details">${P.kv('Client', input.customer.name)}${P.kv('Quote date', input.dateLabel)}${P.kv('Property', input.property)}${P.kv('Quote reference', input.ref)}${P.kv('Contact email', input.customer.email)}${P.kv('Prepared by', preparedBy)}${P.kv('Contact number', input.customer.phone)}${P.kv('Validity', `Valid for ${input.validityDays} days from the date above`)}</div><div style="margin-top:7mm;display:grid;grid-template-columns:44mm 1fr;gap:8mm"><div><span class="eyebrow">Introduction</span><h3 style="margin-top:1.5mm">Your quotation</h3><div class="rule"></div></div><p class="lede">${input.introText}</p></div></div>${P.toc(tocEntries)}${footer(1)}</section>`;

  // 3. Specification.
  const d = input.diagram;
  const cols = input.specCards.length <= 3 ? 'c3' : 'c4';
  const spec = P.page(
    html`<span class="eyebrow">Roof specification</span><h2>${input.specHeading}</h2><div class="rule"></div><div class="cards ${cols}">${input.specCards.map((c) => html`<div class="card${c.accent ? ' gold' : ''}"><div class="big">${c.big}</div><div class="lab">${c.label}</div></div>`)}</div><div style="display:grid;grid-template-columns:1.25fr 1fr;gap:8mm;margin-top:9mm;align-items:center"><div style="background:var(--paper);padding:2mm"><img src="${brand.assets.diagram}" alt="${d.heading}" style="width:100%;display:block"></div><div><span class="eyebrow">${d.eyebrow}</span><h3 style="margin-top:1.5mm">${d.heading}</h3><div class="rule"></div><p>${d.body}</p><p class="small">${d.caption}</p></div></div>${input.callout ? html`<div class="callout" style="margin-top:10mm"><span class="eyebrow">${input.callout.label}</span>${input.callout.text}</div>` : null}`,
    header,
    footer(2),
  );

  // 4. Scope pages.
  const scopePages = groups.map((g, gi) => {
    const lead = gi === 0 ? headFirst : headRest;
    return P.page(html`${lead}<div>${g.map((idx) => items[idx])}</div>`, header, footer(firstScopePage + gi));
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
    html`<span class="eyebrow">Pricing</span><h2>Your investment</h2><div class="rule"></div>${P.priceTable(rows, showVat)}${P.totalsBlock(totalRows, 'Total', formatGBP(totals.grossPence))}<div class="terms" style="margin-top:10mm"><div class="t"><h5>Terms and conditions</h5><p>${input.terms}</p></div>${showVat && tenant.vatNo ? html`<div class="t"><h5>VAT registration number</h5><p class="mono">${tenant.vatNo}</p></div>` : null}</div><div style="margin-top:12mm"><span class="eyebrow">Prepared by</span><div style="margin-top:4mm">${P.signBlock(brand, tenant.ownerName, `${tenant.ownerTitle} · ${tenant.name}`, preparedBy, input.dateLabel)}</div></div><div class="fine" data-reserved style="position:absolute;bottom:0;left:0;right:0"><b>Important information</b>${input.disclaimer}</div>`,
    header,
    footer(total),
  );

  const pages = [cover, spec, ...scopePages, pricing];
  return documentShell({
    title: `${tenant.name} Quotation ${input.ref}`,
    css,
    body: raw(pages.map((p) => p.value).join('')),
  });
}
