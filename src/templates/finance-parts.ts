import { html, type Raw } from '../lib/html';
import type { Brand, Tenant } from '../themes/types';

export interface Customer {
  name: string;
  addressLines: string[];
  email: string;
  phone: string;
}

export interface BankDetails {
  accountName: string;
  bankName: string;
  sortCode: string;
  accountNumber: string;
}

export function financeHeader(t: Tenant, b: Brand, title: string, meta: [string, string][]): Raw {
  return html`<div class="fhead"><div class="l"><img src="${b.assets.logoWhite}" alt="${t.name}"><div class="addr">${t.addressLine}<br>${t.phone} · ${t.email}<br>Company No. ${t.companyNo}</div></div><div class="r"><h1>${title}</h1><div class="meta">${meta.map(([k, v]) => html`<span>${k}</span><span>${v}</span>`)}</div></div></div>`;
}

export function partyBlock(eyebrow: string, c: Customer): Raw {
  return html`<div class="party"><span class="eyebrow">${eyebrow}</span><div class="nm">${c.name}</div><div class="ad">${c.addressLines.map((l) => html`${l}<br>`)}${c.email} · ${c.phone}</div></div>`;
}

export function dueBox(label: string, amount: string, note: string): Raw {
  return html`<div class="duebox"><span class="eyebrow">${label}</span><div class="amt">${amount}</div><div class="when">${note}</div></div>`;
}

export function payCard(bank: BankDetails, reference: string): Raw {
  return html`<div class="paycard"><div class="ph"><span class="eyebrow w">How to pay</span><h3>Payment details</h3><div class="bl">${bank.bankName}</div></div><div class="pg"><div><span>Account name</span><b>${bank.accountName}</b></div><div><span>Sort code</span><b>${bank.sortCode}</b></div><div><span>Account number</span><b>${bank.accountNumber}</b></div><div><span>Payment reference</span><b>${reference}</b></div></div></div>`;
}

export function compactGuaranteeBand(years: number, text: string): Raw {
  return html`<div class="gband" style="margin-top:9mm;padding:4mm 6mm;grid-template-columns:20mm 1fr"><div class="yr" style="font-size:26pt">${years}<small>Year</small></div><div>${text}</div></div>`;
}

export function financeFooter(t: Tenant): Raw {
  return html`<div class="ffoot" data-reserved><span class="tag">${t.tagline}</span><span>${t.name} · ${t.web}</span></div>`;
}

export function financePage(head: Raw, inner: Raw, foot: Raw): Raw {
  return html`<section class="page">${head}<div class="fbody">${inner}</div>${foot}</section>`;
}
