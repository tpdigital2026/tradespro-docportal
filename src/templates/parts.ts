import { html, raw, type Raw } from '../lib/html';
import type { Brand, Tenant } from '../themes/types';

export const pad2 = (n: number): string => String(n).padStart(2, '0');

export function runningHeader(t: Tenant, b: Brand, label: string, ref: string): Raw {
  return html`<div class="rh"><img src="${b.assets.logoColour}" alt="${t.name}"><div class="meta"><span class="eyebrow">${label}</span><div class="ref">${ref}</div></div></div>`;
}

export function runningFooter(t: Tenant, n: number, total: number, reserved = false): Raw {
  return html`<div class="rf"${reserved ? raw(' data-reserved') : null}><span class="tag">${t.tagline}</span><span>${t.name} · Company No. ${t.companyNo}</span><span class="pg">Page ${pad2(n)} / ${pad2(total)}</span></div>`;
}

export function page(inner: Raw, head: Raw | null, foot: Raw | null): Raw {
  return html`<section class="page">${head}<div class="body">${inner}</div>${foot}</section>`;
}

export function kv(k: string, v: string): Raw {
  return html`<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}

export interface ScopeSection {
  heading: string;
  bullets: string[];
}

export function scopeSection(n: number, s: ScopeSection): Raw {
  return html`<div class="scope-sec"><div class="n">${pad2(n)}</div><div><h4>${s.heading}</h4><ul>${s.bullets.map((b) => html`<li>${b}</li>`)}</ul></div></div>`;
}

export function guaranteeBand(years: number, text: string): Raw {
  return html`<div class="gband" style="margin-top:3mm"><div class="yr">${years}<small>Year</small></div><div><h3>${years}-Year Guarantee</h3>${text}</div></div>`;
}

export function toc(entries: [string, number][]): Raw {
  return html`<div class="toc" data-reserved>${entries.map(([label, pg], i) => html`<div><div class="n">${pad2(i + 1)}</div><div class="l">${label}</div><div class="p">Page ${pad2(pg)}</div></div>`)}</div>`;
}

export function coverHero(
  t: Tenant,
  b: Brand,
  c: { eyebrow: string; title: string; sub: string; strip: [string, string][] },
): Raw {
  return html`<div class="cover-hero"><div class="ph" style="background-image:url(&quot;${b.assets.coverPhoto}&quot;)"></div><div class="shade"></div><div class="in" data-fit><img class="logo" src="${b.assets.logoWhite}" alt="${t.name}"><div class="contact">${t.addressLine}<br>${t.phone} · ${t.email}<br>Company No. ${t.companyNo}</div><div class="spacer"></div><span class="eyebrow w">${c.eyebrow}</span><h1>${c.title}</h1><div class="rule"></div><div class="sub">${c.sub}</div><div class="strip">${c.strip.map(([a, v]) => html`<div>${a}<b>${v}</b></div>`)}</div></div></div>`;
}

export interface PriceRow {
  description: string;
  kind: string;
  qty: string;
  unit: string;
  vat: string;
  total: string;
}

export function priceTable(rows: PriceRow[], showVat: boolean): Raw {
  return html`<table class="px"><thead><tr><th>Description</th><th>Type</th><th class="r">Qty</th><th class="r">Unit cost</th>${showVat ? html`<th class="r">VAT</th>` : null}<th class="r">Total</th></tr></thead><tbody>${rows.map((r) => html`<tr><td>${r.description}</td><td><span class="t">${r.kind}</span></td><td class="r">${r.qty}</td><td class="r">${r.unit}</td>${showVat ? html`<td class="r">${r.vat}</td>` : null}<td class="r">${r.total}</td></tr>`)}</tbody></table>`;
}

export function totalsBlock(rows: [string, string][], grandLabel: string, grand: string, after: [string, string][] = []): Raw {
  return html`<div class="totals">${rows.map(([a, b]) => html`<div class="row"><span>${a}</span><span>${b}</span></div>`)}<div class="grand"><span>${grandLabel}</span><span>${grand}</span></div>${after.map(([a, b]) => html`<div class="row sub"><span>${a}</span><span>${b}</span></div>`)}</div>`;
}

export function signBlock(b: Brand, name: string, role: string, nameLine: string, date: string): Raw {
  return html`<div class="sign"><div class="s"><img src="${b.assets.signature}" alt="Signature of ${name}"><div class="line"><div class="nm">${name}</div><div class="rl">${role}</div></div></div><div class="small" style="padding-bottom:1mm">${nameLine}<br>${date}</div></div>`;
}
