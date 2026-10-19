import type { RenderPage as Page } from '../pdf/engine';
import { html, raw } from '../lib/html';
import { balanceDue, balanceStatement, computeTotals, depositOf, formatGBP, type Instalment, type MoneyLine, type Pence } from '../lib/money';
import { documentShell } from '../pdf/document';
import type { Brand, Tenant } from '../themes/types';
import { documentCss } from './css';
import * as F from './finance-parts';
import * as P from './parts';
import { flowScope } from './scope-flow';

// Below .fhead (58mm) and .fbody top padding (8mm), above the footer (9mm tall). The owner's real invoices end their scope, or the guarantee
// band, about 6mm above the footer, so the reserve is 14mm and the measuring safety margin takes the rest.
const FIRST_AREA_MM = 297 - 58 - 8 - 14;
const REST_AREA_MM = 297 - 27 - 19; // .body: top 27mm, bottom 19mm
const BODY_WIDTH_MM = 210 - 2 * 16;

export interface InvoiceCommon {
  /** The locked template this invoice is drawn from (src/templates/registry.ts); absent for the plain layout. */
  template?: string;
  invoiceNo: string;
  quoteRef: string;
  dateLabel: string;
  customer: F.Customer;
  jobTitle: string;
  scope: P.ScopeSection[];
  /** Used in row descriptions, e.g. "flat roof replacement as specified above". */
  jobDescription: string;
  vatRateBp: number;
  quoteLines: MoneyLine[];
  depositPctBp: number;
  guarantee: { years: number; text: string } | null;
  bank: F.BankDetails;
  paymentRef: string;
  /**
   * Payment terms wording, supplied by the caller. A "{balance}" in it becomes the amount still to pay after this
   * invoice (deposit invoices only), so the wording can say "The remaining balance of {balance} is due on completion".
   */
  terms: string;
  /** The "Due" line in the header ("On receipt"). The business supplies it; with none on record the row is left out, never invented. */
  dueLabel?: string;
  disclaimer: string;
}

export interface DepositInvoiceInput extends InvoiceCommon {
  /** For example "Before works start". */
  dueLabel: string;
  /** Label for the balance row, for example "Balance due on completion". */
  balanceDueLabel: string;
}

export interface BalanceInvoiceInput extends InvoiceCommon {
  /** Extra works or credits on top of the quote. Credits have a negative unit price. */
  adjustmentLines: MoneyLine[];
  depositReceiptRef: string | null;
  /** Deposit received, as recorded. Must equal the deposit invoiced. */
  depositReceivedPence: Pence;
  /** Note under the amount due, for example "Payment is due upon receipt of this invoice". */
  dueNote: string;
}

interface InvoiceSpec {
  title: string;
  invoiceNo: string;
  dateLabel: string;
  metaRows: [string, string][];
  customer: F.Customer;
  due: { label: string; amountPence: Pence; note: string };
  jobTitle: string;
  scope: P.ScopeSection[];
  note: string | null;
  rows: P.PriceRow[];
  showVat: boolean;
  totalRows: [string, string][];
  grandLabel: string;
  grandPence: Pence;
  afterRows: [string, string][];
  guarantee: { years: number; text: string } | null;
  bank: F.BankDetails;
  paymentRef: string;
  terms: string;
  disclaimer: string;
}

async function renderInvoice(page: Page, tenant: Tenant, brand: Brand, s: InvoiceSpec): Promise<string> {
  if (s.scope.length === 0) throw new Error('Invoice scope must contain at least one section');
  const css = documentCss(brand);
  const sections = s.scope.map((sec, i) => P.scopeSection(i + 1, sec));
  const headFirst = html`<div class="parties">${F.partyBlock('Invoice for', s.customer)}${F.dueBox(s.due.label, formatGBP(s.due.amountPence), s.due.note)}</div><span class="eyebrow">Scope of works</span><h2>${s.jobTitle}</h2><div class="rule"></div>`;
  const headRest = html`<span class="eyebrow">Scope of works, continued</span><div style="height:3mm"></div>`;
  // The owner's real invoices set the repeated scope in the compact size every time (a 12mm number column, 12pt numerals,
  // tight bullets), so that the scope fills page 1 and the money fits page 2, whatever the length. A scope too long even
  // for that carries on to extra pages (numbering continues), and the overflow check still runs on every page.
  // The guarantee band goes at the foot of page 1 when it fits there (as on the owner's real invoices), else it stays with
  // the payment details on page 2. It is measured as the last item of the scope flow.
  const band = s.guarantee ? F.compactGuaranteeBand(s.guarantee.years, s.guarantee.text) : null;
  const flow = await flowScope({ page, css, widthMm: BODY_WIDTH_MM, firstAreaMm: FIRST_AREA_MM, restAreaMm: REST_AREA_MM, headFirst, headRest, sections, compact: true, trailing: band ? [band] : [], split: { scope: s.scope, build: P.scopeSection } });
  const bandIndex = band ? flow.items.length - 1 : -1;
  const bandOnFirstPage = band !== null && flow.groups.length === 1 && flow.groups[0].includes(bandIndex);
  // Otherwise take the band out of the scope pages and show it on the payment page.
  const groupsNoBand = bandOnFirstPage ? flow.groups : flow.groups.map((g) => g.filter((i) => i !== bandIndex)).filter((g) => g.length > 0);
  flow.groups = groupsNoBand;
  const { items, groups } = flow;
  // On page 1 the real invoices start the first section 1.9mm closer to the rule than the continuation pages do.
  const scopeBox = (g: number[], first: boolean) => html`<div class="scope-compact"${first ? raw(' style="margin-top:-1.9mm"') : null}>${g.filter((i) => i !== bandIndex).map((i) => items[i])}</div>${bandOnFirstPage && g.includes(bandIndex) ? band : null}`;

  const total = groups.length + 1;
  const header = P.runningHeader(tenant, brand, s.title, s.invoiceNo);
  const footer = (n: number, reserved = false) => P.runningFooter(tenant, n, total, reserved);

  const first = F.financePage(
    F.financeHeader(tenant, brand, s.title, [['Date', s.dateLabel], ['Invoice no.', s.invoiceNo], ...s.metaRows]),
    html`${headFirst}${scopeBox(groups[0], true)}`,
    footer(1, true),
  );
  const continuation = groups
    .slice(1)
    .map((g, gi) => P.page(html`${headRest}${scopeBox(g, false)}`, header, footer(gi + 2)));

  const pricing = P.page(
    html`<span class="eyebrow">Amount due</span><h2>Pricing &amp; payment</h2><div class="rule"></div>${s.note ? html`<div class="callout" style="margin-bottom:6mm">${s.note}</div>` : null}${P.priceTable(s.rows, s.showVat)}${P.totalsBlock(s.totalRows, s.grandLabel, formatGBP(s.grandPence), s.afterRows)}${band && !bandOnFirstPage ? band : null}<div style="margin-top:9mm">${F.payCard(s.bank, s.paymentRef)}</div><div class="terms" style="margin-top:9mm"><div class="t"><h5>Terms and conditions</h5><p>${s.terms}</p></div>${s.showVat && tenant.vatNo ? html`<div class="t"><h5>VAT registration number</h5><p class="mono">${tenant.vatNo}</p></div>` : null}</div>${s.disclaimer.trim() ? html`<div class="fine" data-reserved style="position:absolute;bottom:0;left:0;right:0"><b>Important information</b>${s.disclaimer}</div>` : null}`,
    header,
    footer(total),
  );

  return documentShell({
    title: `${tenant.name} ${s.title} ${s.invoiceNo}`,
    css,
    body: raw([first, ...continuation, pricing].map((p) => p.value).join('')),
  });
}

const dueRow = (label: string | undefined): [string, string][] => (label && label.trim() !== '' ? [['Due', label]] : []);

function assertUniformVat(lines: MoneyLine[]): void {
  if (lines.some((l) => l.vatApplies) && lines.some((l) => !l.vatApplies)) {
    throw new Error('Mixed VAT and non-VAT lines are not supported on invoices yet');
  }
}

export async function buildDepositInvoice(page: Page, input: DepositInvoiceInput, tenant: Tenant, brand: Brand): Promise<string> {
  assertUniformVat(input.quoteLines);
  const quote = computeTotals(input.quoteLines, input.vatRateBp);
  const dep = depositOf(quote, input.depositPctBp);
  const showVat = input.quoteLines.some((l) => l.vatApplies);
  const pct = `${input.depositPctBp / 100}%`;
  const rate = `${input.vatRateBp / 100}%`;
  const balance = balanceDue(quote.grossPence, [dep.grossPence]);
  return renderInvoice(page, tenant, brand, {
    title: 'Deposit Invoice',
    invoiceNo: input.invoiceNo,
    dateLabel: input.dateLabel,
    metaRows: [['Quote ref.', input.quoteRef], ['Due', input.dueLabel]],
    customer: input.customer,
    due: { label: 'Total due today', amountPence: dep.grossPence, note: `Payable ${input.dueLabel.toLowerCase()} · ${pct} deposit` },
    jobTitle: input.jobTitle,
    scope: input.scope,
    note: null,
    rows: [
      {
        description: `${pct} Deposit – ${input.jobDescription}`,
        kind: 'Deposit',
        qty: '1',
        unit: formatGBP(dep.netPence),
        vat: showVat ? rate : '0%',
        total: formatGBP(dep.grossPence),
      },
    ],
    showVat,
    totalRows: showVat ? [['Subtotal', formatGBP(dep.netPence)], [`VAT (${rate})`, formatGBP(dep.vatPence)]] : [],
    grandLabel: 'Total due today',
    grandPence: dep.grossPence,
    afterRows: [
      [`Quote total${showVat ? ' (inc. VAT)' : ''}`, formatGBP(quote.grossPence)],
      [input.balanceDueLabel, formatGBP(balance)],
    ],
    guarantee: input.guarantee,
    bank: input.bank,
    paymentRef: input.paymentRef,
    terms: input.terms.split('{balance}').join(formatGBP(balance)),
    disclaimer: input.disclaimer,
  });
}

export async function buildBalanceInvoice(page: Page, input: BalanceInvoiceInput, tenant: Tenant, brand: Brand): Promise<string> {
  assertUniformVat([...input.quoteLines, ...input.adjustmentLines]);
  const st = balanceStatement(input.quoteLines, input.adjustmentLines, input.vatRateBp, input.depositPctBp);
  if (input.depositReceivedPence !== st.deposit.grossPence) {
    throw new RangeError('The deposit received differs from the deposit invoiced; a different deposit amount is not supported yet');
  }
  const showVat = [...input.quoteLines, ...input.adjustmentLines].some((l) => l.vatApplies);
  const pct = `${input.depositPctBp / 100}%`;
  const rate = `${input.vatRateBp / 100}%`;
  const inc = showVat ? ' (inc. VAT)' : '';
  const afterRows: [string, string][] = [[`Quote total${inc}`, formatGBP(st.quote.grossPence)]];
  if (st.adjustments) afterRows.push([`Extras and credits${inc}`, formatGBP(st.adjustments.grossPence)]);
  afterRows.push([`${pct} deposit received`, formatGBP(input.depositReceivedPence)]);
  return renderInvoice(page, tenant, brand, {
    title: 'Balance Invoice',
    invoiceNo: input.invoiceNo,
    dateLabel: input.dateLabel,
    metaRows: [['Quote ref.', input.quoteRef], ...dueRow(input.dueLabel)],
    customer: input.customer,
    due: { label: 'Total due', amountPence: st.balance.grossPence, note: input.dueNote },
    jobTitle: input.jobTitle,
    scope: input.scope,
    note: `Final balance invoice – ${pct} deposit already received${input.depositReceiptRef ? ` (receipt ${input.depositReceiptRef})` : ''}, remaining balance due below.`,
    rows: [
      {
        description: `Balance payment – ${input.jobDescription}`,
        kind: 'Balance',
        qty: '1',
        unit: formatGBP(st.balance.netPence),
        vat: showVat ? rate : '0%',
        total: formatGBP(st.balance.grossPence),
      },
    ],
    showVat,
    totalRows: showVat ? [['Subtotal', formatGBP(st.balance.netPence)], [`VAT (${rate})`, formatGBP(st.balance.vatPence)]] : [],
    grandLabel: 'Total due',
    grandPence: st.balance.grossPence,
    afterRows,
    guarantee: input.guarantee,
    bank: input.bank,
    paymentRef: input.paymentRef,
    terms: input.terms,
    disclaimer: input.disclaimer,
  });
}

export interface FullInvoiceInput extends Omit<InvoiceCommon, 'depositPctBp'> {
  /** Note under the amount due, for example "Payment is due upon receipt of this invoice". */
  dueNote: string;
}

/** One invoice for the whole job: the quote's own lines, paid in one go. */
export async function buildFullInvoice(page: Page, input: FullInvoiceInput, tenant: Tenant, brand: Brand): Promise<string> {
  assertUniformVat(input.quoteLines);
  const quote = computeTotals(input.quoteLines, input.vatRateBp);
  const showVat = input.quoteLines.some((l) => l.vatApplies);
  const rate = `${input.vatRateBp / 100}%`;
  return renderInvoice(page, tenant, brand, {
    title: 'Invoice',
    invoiceNo: input.invoiceNo,
    dateLabel: input.dateLabel,
    metaRows: [['Quote ref.', input.quoteRef], ...dueRow(input.dueLabel)],
    customer: input.customer,
    due: { label: 'Total due', amountPence: quote.grossPence, note: input.dueNote },
    jobTitle: input.jobTitle,
    scope: input.scope,
    note: null,
    rows: quote.lines.map((l) => ({
      description: l.description,
      kind: l.kind,
      qty: String(l.qty),
      unit: formatGBP(l.unitNetPence),
      vat: l.vatApplies ? rate : '0%',
      total: formatGBP(l.grossPence),
    })),
    showVat,
    totalRows: showVat ? [['Subtotal', formatGBP(quote.netPence)], [`VAT (${rate})`, formatGBP(quote.vatPence)]] : [],
    grandLabel: 'Total due',
    grandPence: quote.grossPence,
    afterRows: [],
    guarantee: input.guarantee,
    bank: input.bank,
    paymentRef: input.paymentRef,
    terms: input.terms,
    disclaimer: input.disclaimer,
  });
}

export interface StageInvoiceInput extends Omit<InvoiceCommon, 'depositPctBp'> {
  /** This stage, as worked out by buildSchedule from the quote totals and the plan. */
  stage: Instalment;
  stageCount: number;
  /** Money already received against the earlier stages. */
  receivedPence: Pence;
  dueNote: string;
}

/** One stage of a job paid in stages. The stage amount comes from the schedule; the template only lays it out. */
export async function buildStageInvoice(page: Page, input: StageInvoiceInput, tenant: Tenant, brand: Brand): Promise<string> {
  assertUniformVat(input.quoteLines);
  const quote = computeTotals(input.quoteLines, input.vatRateBp);
  const st = input.stage;
  if (st.netPence + st.vatPence !== st.grossPence || st.grossPence <= 0 || st.grossPence > quote.grossPence) throw new RangeError('The stage amount does not fit the quote');
  const showVat = input.quoteLines.some((l) => l.vatApplies);
  const rate = `${input.vatRateBp / 100}%`;
  const inc = showVat ? ' (inc. VAT)' : '';
  const heading = `Stage ${st.index} of ${input.stageCount}`;
  const afterRows: [string, string][] = [[`Quote total${inc}`, formatGBP(quote.grossPence)]];
  if (input.receivedPence > 0) afterRows.push(['Received for earlier stages', formatGBP(input.receivedPence)]);
  afterRows.push(['Left to pay after this stage', formatGBP(balanceDue(quote.grossPence, [...(input.receivedPence > 0 ? [input.receivedPence] : []), st.grossPence]))]);
  return renderInvoice(page, tenant, brand, {
    title: 'Stage Invoice',
    invoiceNo: input.invoiceNo,
    dateLabel: input.dateLabel,
    metaRows: [['Quote ref.', input.quoteRef], ...dueRow(input.dueLabel), ['Stage', `${st.index} of ${input.stageCount}`]],
    customer: input.customer,
    due: { label: 'Total due', amountPence: st.grossPence, note: input.dueNote },
    jobTitle: input.jobTitle,
    scope: input.scope,
    note: null,
    rows: [
      {
        description: `${heading}: ${st.label} – ${input.jobDescription}`,
        kind: 'Stage',
        qty: '1',
        unit: formatGBP(st.netPence),
        vat: showVat ? rate : '0%',
        total: formatGBP(st.grossPence),
      },
    ],
    showVat,
    totalRows: showVat ? [['Subtotal', formatGBP(st.netPence)], [`VAT (${rate})`, formatGBP(st.vatPence)]] : [],
    grandLabel: 'Total due',
    grandPence: st.grossPence,
    afterRows,
    guarantee: input.guarantee,
    bank: input.bank,
    paymentRef: input.paymentRef,
    terms: input.terms,
    disclaimer: input.disclaimer,
  });
}
