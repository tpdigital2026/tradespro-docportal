import { html, raw, type Raw } from '../lib/html';
import { documentShell } from '../pdf/document';
import type { Brand, Tenant } from '../themes/types';
import { documentCss } from './css';

export interface GuaranteeInput {
  certificateNo: string;
  years: number;
  workDescription: string;
  address: string;
  /** dd/mm/yyyy */
  completedLabel: string;
  /** The guarantee wording. Always supplied by the business, never written by code. */
  statement: string;
  disclaimerLine: string | null;
  /** The locked template this certificate is drawn from (src/templates/registry.ts); absent for the plain layout. */
  template?: string;
}

// Circumference of the r=74 text circle, minus a little so the end never touches the start.
const SEAL_TEXT_LENGTH = 458;
const SEAL_MIN_FONT_PX = 6;
const SEAL_MAX_FONT_PX = 10;
// Approximate advance width of one monospace glyph, in em.
const GLYPH_EM = 0.62;

function seal(t: Tenant, years: number): Raw {
  const label = `${t.name.toUpperCase()} · ${years} YEAR GUARANTEE · `;
  // Shrink the type to suit the label so lengthAdjust never has to squeeze glyphs into each other.
  const fontPx = Math.round(Math.min(SEAL_MAX_FONT_PX, SEAL_TEXT_LENGTH / (label.length * GLYPH_EM)) * 100) / 100;
  if (fontPx < SEAL_MIN_FONT_PX) throw new Error('The business name is too long for the guarantee seal');
  return html`<svg viewBox="0 0 200 200" width="46mm" height="46mm" role="img" aria-label="${years} year guarantee seal"><defs><path id="seal-arc" d="M100,100 m-74,0 a74,74 0 1,1 148,0 a74,74 0 1,1 -148,0"/></defs><circle cx="100" cy="100" r="96" style="fill:var(--navy)"/><circle cx="100" cy="100" r="89" style="fill:none;stroke:var(--gold);stroke-width:1.6"/><circle cx="100" cy="100" r="60" style="fill:none;stroke:var(--gold);stroke-width:.8"/><text style="font-family:Mono;font-size:${fontPx}px;fill:var(--gold2)"><textPath href="#seal-arc" textLength="${SEAL_TEXT_LENGTH}" lengthAdjust="spacing">${label}</textPath></text><text x="100" y="113" text-anchor="middle" style="font-family:Playfair;font-weight:600;font-size:50px;fill:#fff">${years}</text><text x="100" y="134" text-anchor="middle" style="font-family:Mono;font-size:8.5px;letter-spacing:3px;fill:var(--gold)">YEARS</text></svg>`;
}

export function buildGuarantee(input: GuaranteeInput, tenant: Tenant, brand: Brand): string {
  const inner = html`<section class="page"><div class="cert"><div class="frame"></div><div class="in" data-fit><img src="${brand.assets.logoColour}" alt="${tenant.name}" data-slot="logo-colour" style="height:21mm">${tenant.tagline ? html`<span class="eyebrow g" style="margin-top:5mm;letter-spacing:.34em">${tenant.tagline}</span>` : null}<div style="font-family:Playfair;font-size:14pt;color:var(--muted);margin-top:11mm;font-style:italic">Certificate of</div><h1 style="font-size:40pt;color:var(--navy);margin-top:1mm">Guarantee</h1><div class="rule g" style="margin:5mm auto 7mm;width:24mm"></div><p style="font-size:10pt;color:var(--body)">This certifies that the ${input.workDescription} installed at</p><div class="serif" style="font-size:19pt;margin:2mm 0 2mm">${input.address}</div><p style="font-size:10pt">was installed by <b style="font-family:Playfair;font-size:12pt;color:var(--navy)">${tenant.name}</b></p><div style="margin:8mm 0 4mm">${seal(tenant, input.years)}</div><span class="eyebrow" style="font-size:7.4pt">${input.years} Year Guarantee</span><div class="mono" style="margin-top:6mm;font-size:8pt;color:var(--ink);border-top:.3mm solid var(--gold2);border-bottom:.3mm solid var(--gold2);padding:2.2mm 8mm">INSTALLATION COMPLETED · ${input.completedLabel}</div><p style="font-size:9.6pt;max-width:130mm;margin-top:7mm;line-height:1.6">${input.statement}</p>${input.disclaimerLine ? html`<div class="mono" style="font-size:6.4pt;letter-spacing:.14em;color:var(--muted);margin-top:3mm">${input.disclaimerLine.toUpperCase()}</div>` : null}<div style="flex:1"></div><div style="width:100%;display:flex;justify-content:space-between;align-items:flex-end;text-align:left"><div class="sign"><div class="s">${brand.assets.signature ? html`<img src="${brand.assets.signature}" alt="Signature of ${tenant.ownerName}">` : html`<div style="height:13mm"></div>`}<div class="line"><div class="nm">${tenant.ownerName}</div><div class="rl">Authorised signature · ${tenant.ownerTitle}</div></div></div></div><div style="text-align:right" class="mono">${tenant.web ? html`<div style="font-size:7pt;color:var(--ink)">${tenant.web}</div>` : null}${tenant.email ? html`<div style="font-size:7pt;color:var(--ink)">${tenant.email}</div>` : null}${tenant.companyNo ? html`<div style="font-size:6pt;color:var(--muted);letter-spacing:.14em;margin-top:1mm">COMPANY NO. ${tenant.companyNo}</div>` : null}</div></div></div></div></section>`;
  return documentShell({
    title: `${tenant.name} Guarantee ${input.certificateNo}`,
    css: documentCss(brand),
    body: raw(inner.value),
  });
}
