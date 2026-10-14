# Invoices, Receipts and Guarantee Certificate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the deposit invoice, balance invoice, receipt (deposit and paid in full) and guarantee certificate from code in the FJC brand, with money computed only by `money.ts`, scope text flowing across pages, and fail-closed overflow checks.

**Architecture:** Reuses Plan 1's pipeline (`html` tag, Chromium, `paginate`, overflow guard). The scope-flow logic is extracted from the quotation into a shared `flowScope()` so invoices use the same pagination. A new `finance-parts.ts` holds the financial-document components. One internal `renderInvoice()` serves both invoice types; receipt and guarantee are single-page builders. The survey report is a later plan.

**Tech Stack:** Same as Plan 1 (Next.js, TypeScript, Vitest, playwright-core).

**Spec:** `docs/superpowers/specs/2026-10-14-docportal-design.md`. Builds on `docs/superpowers/plans/2026-10-14-foundation-and-render-spike.md` (done).

## Global Constraints

- Node v24 on macOS. No Homebrew, no Docker, no poppler. Page checks use Chromium screenshots, never pdf.js.
- Money is integer pence only. VAT is per line, rounded half away from zero, then summed. A deposit is its percentage of the ex-VAT subtotal and of the VAT. Balance is the quote total (plus extras, minus credits) minus the deposit, with net and VAT split by subtraction. The AI never calculates money. Only `src/lib/money.ts` computes amounts; templates only format them with `formatGBP`.
- Percentages and rates are basis points (20% VAT is `2000`, a 30% deposit is `3000`).
- All HTML is built with the `html` tagged template. Only `raw()` bypasses escaping, and only for trusted markup. Quote HTML attributes. Never interpolate user text into `style`, `href`/`src`, event handlers or script.
- Documents are A4, 210mm by 297mm, fixed pages with a fixed footer. A page that overflows or collides with a reserved box must throw `PageOverflowError`, never clip silently.
- Nothing on a document may be invented: guarantee wording, terms, disclaimers, bank details, signatory name and role all come from input or the tenant record, never from code. Template-owned copy is limited to labels and the reference's structural wording.
- Fixtures use dummy data only: Mr John Smith, 123 Bromley Road, Bromley, BR2 8BG, john.smith@example.com, 07700 900123, bank 00-00-00 / 00000000. FJC business details (company name, company number, public contact, VAT number) are allowed. Never use real customer names, emails, phones or bank numbers, and never log bank details.
- Use relative imports (no path aliases). UK English. No em dashes in code comments or copy (en dashes in descriptions that copy the reference, such as "30% Deposit – re-roof", are allowed).
- Never commit `reference/`, `out/`, `.env*`, keys or any client personal data. Commit locally only; Alfie pushes.
- Render tests in this plan use `fakeBrand` (1x1 images) so they run on any checkout. The spike script uses the real FJC assets from `reference/`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/money.ts` (modify) | Add `balanceStatement()` |
| `src/templates/css.ts` (new) | `documentCss(brand)` |
| `src/templates/scope-flow.ts` (new) | `flowScope()` shared scope pagination |
| `src/templates/parts.ts` (modify) | `totalsBlock` after-rows, `runningFooter` reserved flag, `data-fit` on cover content layer |
| `src/pdf/render.ts` (modify) | Guard uses `[data-fit]` instead of `.cover-hero .in` |
| `src/templates/quotation.ts` (modify) | Use `documentCss` and `flowScope` (behaviour unchanged) |
| `src/templates/finance-parts.ts` (new) | Header, party block, due box, pay card, compact guarantee band, footer, page wrapper |
| `src/templates/invoice.ts` (new) | `buildDepositInvoice`, `buildBalanceInvoice` |
| `src/templates/receipt.ts` (new) | `buildReceipt` |
| `src/templates/guarantee.ts` (new) | `buildGuarantee` |
| `tests/fixtures/fake.ts`, `common.ts`, `invoices.ts`, `receipts.ts`, `guarantee.ts` | Dummy data |
| `tests/unit/*.test.ts`, `tests/render/*.test.ts` | Tests |
| `scripts/render-spike.ts` (modify) | Render every document type for review |

---

### Task 1: Balance statement in the money library

**Files:**
- Modify: `src/lib/money.ts`
- Test: `tests/unit/money.test.ts`

**Interfaces:**
- Consumes: `computeTotals`, `depositOf`, `Totals`, `MoneyLine`, `Pence` (existing).
- Produces:
  - `interface BalanceStatement { quote: Totals; adjustments: Totals | null; deposit: { netPence: Pence; vatPence: Pence; grossPence: Pence }; balance: { netPence: Pence; vatPence: Pence; grossPence: Pence }; totalGrossPence: Pence }`
  - `balanceStatement(quoteLines: MoneyLine[], adjustmentLines: MoneyLine[], rateBp: number, depositPctBp: number): BalanceStatement` (adjustment lines are extra works or credits; credits have a negative `unitNetPence`)

- [ ] **Step 1: Write the failing tests** (append to `tests/unit/money.test.ts`, adding `balanceStatement` to the import list)

```ts
describe('balanceStatement', () => {
  const quote: MoneyLine[] = [line(274500)];

  it('splits the balance into net and VAT by subtraction: 1,921.50 + 384.30 = 2,305.80', () => {
    const s = balanceStatement(quote, [], 2000, 3000);
    expect(s.quote.grossPence).toBe(329400);
    expect(s.adjustments).toBeNull();
    expect(s.deposit.grossPence).toBe(98820);
    expect(s.balance.netPence).toBe(192150);
    expect(s.balance.vatPence).toBe(38430);
    expect(s.balance.grossPence).toBe(230580);
    expect(s.totalGrossPence).toBe(329400);
  });

  it('adds extra works to the balance without changing the deposit', () => {
    const s = balanceStatement(quote, [line(50000, { description: 'Extra ply boards' })], 2000, 3000);
    expect(s.adjustments?.grossPence).toBe(60000);
    expect(s.deposit.grossPence).toBe(98820);
    expect(s.totalGrossPence).toBe(389400);
    expect(s.balance.grossPence).toBe(290580);
  });

  it('subtracts a credit (negative line)', () => {
    const s = balanceStatement(quote, [line(-10000, { description: 'Goodwill credit' })], 2000, 3000);
    expect(s.adjustments?.grossPence).toBe(-12000);
    expect(s.balance.grossPence).toBe(218580);
  });

  it('balance plus deposit always equals the total', () => {
    const s = balanceStatement([line(123457)], [line(3333)], 2000, 2500);
    expect(s.balance.grossPence + s.deposit.grossPence).toBe(s.totalGrossPence);
  });

  it('rejects a deposit larger than the total', () => {
    expect(() => balanceStatement([line(100000)], [line(-100000)], 2000, 3000)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/money.test.ts`
Expected: FAIL, `balanceStatement` is not exported.

- [ ] **Step 3: Implement** (append to `src/lib/money.ts`)

```ts
export interface BalanceStatement {
  quote: Totals;
  adjustments: Totals | null;
  deposit: { netPence: Pence; vatPence: Pence; grossPence: Pence };
  balance: { netPence: Pence; vatPence: Pence; grossPence: Pence };
  totalGrossPence: Pence;
}

/** Balance invoice maths. The deposit is taken on the original quote only; extras and credits sit on top. */
export function balanceStatement(
  quoteLines: MoneyLine[],
  adjustmentLines: MoneyLine[],
  rateBp: number,
  depositPctBp: number,
): BalanceStatement {
  const quote = computeTotals(quoteLines, rateBp);
  const adjustments = adjustmentLines.length > 0 ? computeTotals(adjustmentLines, rateBp) : null;
  const all = computeTotals([...quoteLines, ...adjustmentLines], rateBp);
  const deposit = depositOf(quote, depositPctBp);
  const balance = {
    netPence: all.netPence - deposit.netPence,
    vatPence: all.vatPence - deposit.vatPence,
    grossPence: all.grossPence - deposit.grossPence,
  };
  if (balance.grossPence < 0) throw new RangeError('The deposit is larger than the total');
  return { quote, adjustments, deposit, balance, totalGrossPence: all.grossPence };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/money.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money.ts tests/unit/money.test.ts
git commit -m "feat: balance statement maths for balance invoices"
```

---

### Task 2: Shared plumbing (css helper, flowScope, parts and guard tweaks)

**Files:**
- Create: `src/templates/css.ts`, `src/templates/scope-flow.ts`, `tests/fixtures/fake.ts`
- Modify: `src/templates/parts.ts`, `src/pdf/render.ts`, `src/templates/quotation.ts`
- Test: `tests/unit/parts.test.ts`, `tests/render/scope-flow.test.ts`

**Interfaces:**
- Consumes: `fontFaceCss`, `loadBaseCss`, `themeVarsCss`, `measureFragments`, `PX_PER_MM`, `paginate`, `Raw`.
- Produces:
  - `documentCss(brand: Brand): string`
  - `interface ScopeFlowOptions { page: Page; css: string; widthMm: number; firstAreaMm: number; restAreaMm: number; headFirst: Raw; headRest: Raw; sections: Raw[]; trailing?: Raw[] }`
  - `interface ScopeFlow { items: Raw[]; groups: number[][] }` and `flowScope(o: ScopeFlowOptions): Promise<ScopeFlow>` (sections get a per-item border allowance, trailing items do not)
  - `runningFooter(t, n, total, reserved?: boolean)`; `totalsBlock(rows, grandLabel, grand, after?: [string, string][])`
  - `fakeBrand: Brand`, `fakeTenant: Tenant` (test-only, 1x1 image data URIs)
  - The overflow guard checks every `[data-fit]` element for clipped content (the cover hero's content layer now carries `data-fit`).

- [ ] **Step 1: Write the fixtures and failing tests**

`tests/fixtures/fake.ts`:
```ts
import type { Brand, Tenant } from '../../src/themes/types';
import { fjcColours, fjcTenant } from './fjc';

// A valid 1x1 PNG so render tests run on any checkout without the reference assets.
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const fakeTenant: Tenant = { ...fjcTenant };

export const fakeBrand: Brand = {
  colours: fjcColours,
  assets: { logoColour: PIXEL, logoWhite: PIXEL, signature: PIXEL, coverPhoto: PIXEL, diagram: PIXEL },
};
```

`tests/unit/parts.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { coverHero, runningFooter, totalsBlock } from '../../src/templates/parts';
import { fakeBrand, fakeTenant } from '../fixtures/fake';

describe('runningFooter', () => {
  it('is not reserved by default', () => {
    expect(runningFooter(fakeTenant, 1, 2).value).not.toContain('data-reserved');
  });
  it('can be marked reserved so overlap is detected', () => {
    expect(runningFooter(fakeTenant, 1, 2, true).value).toContain('class="rf" data-reserved');
  });
  it('pads page numbers', () => {
    expect(runningFooter(fakeTenant, 1, 12).value).toContain('Page 01 / 12');
  });
});

describe('totalsBlock', () => {
  it('renders after-rows below the grand total, escaped', () => {
    const v = totalsBlock([['Subtotal', '£1.00']], 'Total', '£1.20', [['Balance <due>', '£0.50']]).value;
    expect(v.indexOf('class="grand"')).toBeLessThan(v.indexOf('class="row sub"'));
    expect(v).toContain('Balance &lt;due&gt;');
  });
  it('still works without after-rows', () => {
    expect(totalsBlock([], 'Total', '£1.20').value).not.toContain('row sub');
  });
});

describe('coverHero', () => {
  it('marks its content layer so clipped content is detected', () => {
    const v = coverHero(fakeTenant, fakeBrand, { eyebrow: 'e', title: 't', sub: 's', strip: [] }).value;
    expect(v).toContain('class="in" data-fit');
  });
});
```

`tests/render/scope-flow.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { html } from '../../src/lib/html';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { PaginationError } from '../../src/pdf/paginate';
import { documentCss } from '../../src/templates/css';
import { scopeSection } from '../../src/templates/parts';
import { flowScope } from '../../src/templates/scope-flow';
import { fakeBrand } from '../fixtures/fake';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await launchBrowser();
  page = await newLockedPage(browser);
});
afterAll(async () => {
  await browser.close();
});

const css = () => documentCss(fakeBrand);
const sec = (n: number) => scopeSection(n, { heading: `Section ${n}`, bullets: ['One short bullet.', 'Another short bullet.'] });
const heads = { headFirst: html`<h2>First</h2>`, headRest: html`<h2>Rest</h2>` };

describe('flowScope', () => {
  it('keeps a short scope on one page', async () => {
    const r = await flowScope({ page, css: css(), widthMm: 178, firstAreaMm: 200, restAreaMm: 250, ...heads, sections: [1, 2, 3].map(sec) });
    expect(r.groups).toEqual([[0, 1, 2]]);
    expect(r.items).toHaveLength(3);
  });

  it('spills onto later pages in order using the rest area', async () => {
    const sections = Array.from({ length: 12 }, (_, i) => sec(i + 1));
    const r = await flowScope({ page, css: css(), widthMm: 178, firstAreaMm: 60, restAreaMm: 100, ...heads, sections });
    expect(r.groups.length).toBeGreaterThan(1);
    expect(r.groups.flat()).toEqual(sections.map((_, i) => i));
  });

  it('places trailing items after the sections, on the last page', async () => {
    const band = html`<div class="gband"><div class="yr">20</div><div>Guarantee</div></div>`;
    const r = await flowScope({ page, css: css(), widthMm: 178, firstAreaMm: 200, restAreaMm: 250, ...heads, sections: [sec(1)], trailing: [band] });
    expect(r.items).toHaveLength(2);
    expect(r.groups.at(-1)?.at(-1)).toBe(1);
  });

  it('throws when one section cannot fit a page', async () => {
    await expect(
      flowScope({ page, css: css(), widthMm: 178, firstAreaMm: 20, restAreaMm: 20, ...heads, sections: [sec(1)] }),
    ).rejects.toBeInstanceOf(PaginationError);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/parts.test.ts && npm run test:render -- tests/render/scope-flow.test.ts`
Expected: FAIL (new exports and files do not exist yet).

- [ ] **Step 3: Implement**

`src/templates/css.ts`:
```ts
import { fontFaceCss } from '../pdf/assets';
import { loadBaseCss, themeVarsCss } from '../themes/theme';
import type { Brand } from '../themes/types';

export function documentCss(brand: Brand): string {
  return [fontFaceCss(), loadBaseCss(), themeVarsCss(brand.colours)].join('\n');
}
```

`src/templates/scope-flow.ts`:
```ts
import type { Page } from 'playwright-core';
import type { Raw } from '../lib/html';
import { measureFragments, PX_PER_MM } from '../pdf/measure';
import { paginate } from '../pdf/paginate';

const SAFETY_PX = 12;
// Each measured .scope-sec matches :first-of-type (no border); on the page every later one gains a 0.3mm top border.
const SECTION_BORDER_PX = 0.3 * PX_PER_MM;

export interface ScopeFlowOptions {
  page: Page;
  css: string;
  widthMm: number;
  /** Vertical space on the first page for everything flowed, heading included. */
  firstAreaMm: number;
  /** Vertical space on each later page, heading included. */
  restAreaMm: number;
  headFirst: Raw;
  headRest: Raw;
  sections: Raw[];
  /** Items placed after the sections (for example a guarantee band). They get no border allowance. */
  trailing?: Raw[];
}

export interface ScopeFlow {
  items: Raw[];
  groups: number[][];
}

export async function flowScope(o: ScopeFlowOptions): Promise<ScopeFlow> {
  const items = [...o.sections, ...(o.trailing ?? [])];
  const [hFirst, hRest, ...measured] = await measureFragments(o.page, o.css, o.widthMm, [o.headFirst, o.headRest, ...items]);
  const heights = measured.map((h, i) => (i < o.sections.length ? h + SECTION_BORDER_PX : h));
  const groups = paginate(heights, {
    first: o.firstAreaMm * PX_PER_MM - hFirst - SAFETY_PX,
    rest: o.restAreaMm * PX_PER_MM - hRest - SAFETY_PX,
  });
  return { items, groups };
}
```

`src/templates/parts.ts` changes:
```ts
// line 1: import { html, raw, type Raw } from '../lib/html';

export function runningFooter(t: Tenant, n: number, total: number, reserved = false): Raw {
  return html`<div class="rf"${reserved ? raw(' data-reserved') : null}><span class="tag">${t.tagline}</span><span>${t.name} · Company No. ${t.companyNo}</span><span class="pg">Page ${pad2(n)} / ${pad2(total)}</span></div>`;
}

export function totalsBlock(rows: [string, string][], grandLabel: string, grand: string, after: [string, string][] = []): Raw {
  return html`<div class="totals">${rows.map(([a, b]) => html`<div class="row"><span>${a}</span><span>${b}</span></div>`)}<div class="grand"><span>${grandLabel}</span><span>${grand}</span></div>${after.map(([a, b]) => html`<div class="row sub"><span>${a}</span><span>${b}</span></div>`)}</div>`;
}
```
and in `coverHero` change `<div class="in">` to `<div class="in" data-fit>`.

`src/pdf/render.ts`: replace `pg.querySelectorAll<HTMLElement>('.cover-hero .in')` with `pg.querySelectorAll<HTMLElement>('[data-fit]')` and update the comment above it to "anything that hides its overflow, plus every [data-fit] box".

`src/templates/quotation.ts`: replace the imports for `fontFaceCss`, `measureFragments`, `paginate`, `loadBaseCss`, `themeVarsCss` with:
```ts
import { PX_PER_MM } from '../pdf/measure'; // remove if unused after the edit
import { documentCss } from './css';
import { flowScope } from './scope-flow';
```
Delete the `SAFETY_PX` and `SECTION_BORDER_PX` constants (keep `BODY_MM` and `BODY_WIDTH_MM`). Replace line 42 with `const css = documentCss(brand);`. Replace the measuring and pagination block (from `const items: Raw[] = ...` through `const groups = paginate(...)`) with:
```ts
  const headFirst = html`<span class="eyebrow">Scope of works</span><h2>${input.scopeHeading}</h2><div class="rule"></div>`;
  const headRest = html`<span class="eyebrow">Scope of works, continued</span><div style="height:3mm"></div>`;
  const { items, groups } = await flowScope({
    page,
    css,
    widthMm: BODY_WIDTH_MM,
    firstAreaMm: BODY_MM,
    restAreaMm: BODY_MM,
    headFirst,
    headRest,
    sections: sectionFrags,
    trailing: band ? [band] : [],
  });
```
(Keep the `sectionFrags` and `band` lines above it.) Remove any import that becomes unused so `tsc` stays clean.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run test:render && npx tsc --noEmit`
Expected: all pass, including every existing quotation test (behaviour must be unchanged, including the clipped-cover guard test).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "refactor: share scope flow and css helpers, data-fit guard hook"
```

---

### Task 3: Financial document components

**Files:**
- Create: `src/templates/finance-parts.ts`, `tests/fixtures/common.ts`
- Test: `tests/unit/finance-parts.test.ts`

**Interfaces:**
- Consumes: `html`, `Raw`, `Brand`, `Tenant`.
- Produces:
  - `interface Customer { name: string; addressLines: string[]; email: string; phone: string }`
  - `interface BankDetails { accountName: string; bankName: string; sortCode: string; accountNumber: string }`
  - `financeHeader(t: Tenant, b: Brand, title: string, meta: [string, string][]): Raw`
  - `partyBlock(eyebrow: string, c: Customer): Raw`
  - `dueBox(label: string, amount: string, note: string): Raw`
  - `payCard(bank: BankDetails, reference: string): Raw`
  - `compactGuaranteeBand(years: number, text: string): Raw`
  - `financeFooter(t: Tenant): Raw` (marked `data-reserved`)
  - `financePage(head: Raw, inner: Raw, foot: Raw): Raw`

- [ ] **Step 1: Write the fixtures and failing tests**

`tests/fixtures/common.ts`:
```ts
import type { BankDetails, Customer } from '../../src/templates/finance-parts';

export const customer: Customer = {
  name: 'Mr John Smith',
  addressLines: ['123 Bromley Road', 'Bromley', 'BR2 8BG'],
  email: 'john.smith@example.com',
  phone: '07700 900123',
};

export const bank: BankDetails = {
  accountName: 'FJC Roofing Ltd',
  bankName: 'Metro Bank',
  sortCode: '00-00-00',
  accountNumber: '00000000',
};
```

`tests/unit/finance-parts.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { html } from '../../src/lib/html';
import {
  compactGuaranteeBand,
  dueBox,
  financeFooter,
  financeHeader,
  financePage,
  partyBlock,
  payCard,
} from '../../src/templates/finance-parts';
import { bank, customer } from '../fixtures/common';
import { fakeBrand, fakeTenant } from '../fixtures/fake';

describe('financeHeader', () => {
  it('shows the title, business contact lines and meta rows', () => {
    const v = financeHeader(fakeTenant, fakeBrand, 'Deposit Invoice', [['Date', '07/10/2026'], ['Invoice no.', 'INV-JS-001-D']]).value;
    expect(v).toContain('<h1>Deposit Invoice</h1>');
    expect(v).toContain('Company No. 13855379');
    expect(v).toContain('<span>Invoice no.</span><span>INV-JS-001-D</span>');
  });
  it('escapes meta values', () => {
    expect(financeHeader(fakeTenant, fakeBrand, 'T', [['Ref', '<b>x</b>']]).value).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('partyBlock', () => {
  it('lists each address line, then email and phone', () => {
    const v = partyBlock('Invoice for', customer).value;
    expect(v).toContain('Invoice for');
    expect(v).toContain('123 Bromley Road<br>Bromley<br>BR2 8BG<br>');
    expect(v).toContain('john.smith@example.com · 07700 900123');
  });
  it('escapes the customer name', () => {
    expect(partyBlock('x', { ...customer, name: '<script>1</script>' }).value).not.toContain('<script>');
  });
});

describe('dueBox', () => {
  it('shows the label, amount and note', () => {
    const v = dueBox('Total due today', '£988.20', 'Payable before works start').value;
    expect(v).toContain('Total due today');
    expect(v).toContain('£988.20');
    expect(v).toContain('Payable before works start');
  });
});

describe('payCard', () => {
  it('shows every bank field and the reference', () => {
    const v = payCard(bank, 'INV-JS-001-D').value;
    for (const s of ['Metro Bank', 'FJC Roofing Ltd', '00-00-00', '00000000', 'INV-JS-001-D']) expect(v).toContain(s);
  });
  it('escapes bank fields', () => {
    expect(payCard({ ...bank, bankName: 'A<B' }, 'r').value).toContain('A&lt;B');
  });
});

describe('compactGuaranteeBand', () => {
  it('shows the years and the supplied text', () => {
    const v = compactGuaranteeBand(25, 'The roofing system is covered.').value;
    expect(v).toContain('25<small>Year</small>');
    expect(v).toContain('The roofing system is covered.');
  });
});

describe('financeFooter and financePage', () => {
  it('footer is a reserved box with tagline and website', () => {
    const v = financeFooter(fakeTenant).value;
    expect(v).toContain('class="ffoot" data-reserved');
    expect(v).toContain(fakeTenant.web);
  });
  it('wraps header, body and footer in a page', () => {
    const v = financePage(html`<div id="h"></div>`, html`<p>in</p>`, html`<div id="f"></div>`).value;
    expect(v).toBe('<section class="page"><div id="h"></div><div class="fbody"><p>in</p></div><div id="f"></div></section>');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/finance-parts.test.ts`
Expected: FAIL, cannot resolve `finance-parts`.

- [ ] **Step 3: Implement**

`src/templates/finance-parts.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/finance-parts.test.ts && npx tsc --noEmit`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/templates/finance-parts.ts tests/unit/finance-parts.test.ts tests/fixtures/common.ts
git commit -m "feat: financial document components"
```

---

### Task 4: Deposit and balance invoices

**Files:**
- Create: `src/templates/invoice.ts`, `tests/fixtures/invoices.ts`
- Test: `tests/render/invoices.test.ts`

**Interfaces:**
- Consumes: `balanceStatement`, `computeTotals`, `depositOf`, `formatGBP`, `MoneyLine`, `Pence`; `documentCss`, `flowScope`, `documentShell`; parts (`scopeSection`, `page`, `runningHeader`, `runningFooter`, `priceTable`, `totalsBlock`, `ScopeSection`, `PriceRow`); finance parts.
- Produces:
  - `interface InvoiceCommon { invoiceNo: string; quoteRef: string; dateLabel: string; customer: Customer; jobTitle: string; scope: ScopeSection[]; jobDescription: string; vatRateBp: number; quoteLines: MoneyLine[]; depositPctBp: number; guarantee: { years: number; text: string } | null; bank: BankDetails; paymentRef: string; disclaimer: string }`
  - `interface DepositInvoiceInput extends InvoiceCommon { dueLabel: string }`
  - `interface BalanceInvoiceInput extends InvoiceCommon { adjustmentLines: MoneyLine[]; depositReceiptRef: string | null }`
  - `buildDepositInvoice(page: Page, input: DepositInvoiceInput, tenant: Tenant, brand: Brand): Promise<string>`
  - `buildBalanceInvoice(page: Page, input: BalanceInvoiceInput, tenant: Tenant, brand: Brand): Promise<string>`
  - Both return a full HTML document: page 1 (header, parties, due box, scope), optional continuation pages, then a pricing and payment page. Page count is `1 + continuation + 1`.

- [ ] **Step 1: Write the fixtures and failing tests**

`tests/fixtures/invoices.ts`:
```ts
import type { MoneyLine } from '../../src/lib/money';
import type { BalanceInvoiceInput, DepositInvoiceInput, InvoiceCommon } from '../../src/templates/invoice';
import { bank, customer } from './common';

const quoteLines: MoneyLine[] = [
  { description: 'Flat roof replacement', kind: 'Work', qty: 1, unitNetPence: 274500, vatApplies: true },
];

const common: InvoiceCommon = {
  invoiceNo: 'INV-JS-001-D',
  quoteRef: 'QT-JS-001',
  dateLabel: '07/10/2026',
  customer,
  jobTitle: 'Flat Roof Replacement',
  jobDescription: 'flat roof replacement as specified above',
  scope: [
    { heading: 'Site set-up', bullets: ['No skip is needed, as all rubbish will be loaded onto the back of our truck.'] },
    {
      heading: 'Removal process',
      bullets: [
        'All original felt will be removed to expose the ply deck.',
        'A full inspection will be carried out on the ply deck to make sure it is in adequate condition.',
      ],
    },
    {
      heading: 'Felt roofing system',
      bullets: [
        'A 2mm perforated tack-down layer will be installed.',
        'A 3mm underlay will be installed, fully bonded, with all edging flashings.',
        'A 5mm mineral cap sheet will be installed with all edging flashings and drip edges.',
      ],
    },
  ],
  vatRateBp: 2000,
  quoteLines,
  depositPctBp: 3000,
  guarantee: { years: 20, text: 'The roofing system specified above allows us to provide a 20 year guarantee on this roof.' },
  bank,
  paymentRef: 'INV-JS-001-D',
  disclaimer:
    'This invoice is generated using third-party software. The platform is not a party to any contract formed between the customer and the trader for the services listed within this document. The platform has not benchmarked, endorsed, or verified the services or prices stated. For information on how personal data is processed, please refer to the relevant Privacy Notice.',
};

export const depositInvoiceFixture: DepositInvoiceInput = { ...common, dueLabel: 'Before works start' };

export const balanceInvoiceFixture: BalanceInvoiceInput = {
  ...common,
  invoiceNo: 'INV-JS-001-B',
  paymentRef: 'INV-JS-001-B',
  adjustmentLines: [],
  depositReceiptRef: 'RCP-JS-001-D',
};
```

`tests/render/invoices.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { PageOverflowError, renderPdf } from '../../src/pdf/render';
import { buildBalanceInvoice, buildDepositInvoice } from '../../src/templates/invoice';
import { fakeBrand, fakeTenant } from '../fixtures/fake';
import { balanceInvoiceFixture, depositInvoiceFixture } from '../fixtures/invoices';

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

describe('deposit invoice', () => {
  it('renders two pages with the deposit maths from money.ts', async () => {
    const doc = await buildDepositInvoice(page, depositInvoiceFixture, fakeTenant, fakeBrand);
    const pdf = await renderPdf(page, doc);
    expect(await page.$$eval('.page', (p) => p.length)).toBe(2);
    expect(pdfPages(pdf)).toBe(2);
    const t = await text();
    for (const s of ['Deposit Invoice', 'INV-JS-001-D', 'QT-JS-001', '£988.20', '£823.50', '£164.70', '£3,294.00', '£2,305.80', '30% Deposit']) {
      expect(t).toContain(s);
    }
    expect(t).toContain('The 30% deposit is payable before works start. The remaining balance of £2,305.80 is due on completion of works.');
  });

  it('shows the dummy bank details and the payment reference', async () => {
    await renderPdf(page, await buildDepositInvoice(page, depositInvoiceFixture, fakeTenant, fakeBrand));
    const t = await text();
    for (const s of ['Metro Bank', '00-00-00', '00000000']) expect(t).toContain(s);
  });

  it('omits the guarantee band when there is no guarantee', async () => {
    const doc = await buildDepositInvoice(page, { ...depositInvoiceFixture, guarantee: null }, fakeTenant, fakeBrand);
    await renderPdf(page, doc);
    expect(await page.$$eval('.gband', (e) => e.length)).toBe(0);
  });

  it('drops VAT rows and the VAT number when the job has no VAT', async () => {
    const input = {
      ...depositInvoiceFixture,
      quoteLines: depositInvoiceFixture.quoteLines.map((l) => ({ ...l, vatApplies: false })),
    };
    await renderPdf(page, await buildDepositInvoice(page, input, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).not.toContain('VAT registration number');
    expect(t).not.toContain('Subtotal');
    expect(t).toContain('Quote total');
    expect(t).not.toContain('Quote total (inc. VAT)');
  });

  it('escapes customer text', async () => {
    const input = { ...depositInvoiceFixture, customer: { ...depositInvoiceFixture.customer, name: '<img src=x onerror=alert(1)>' } };
    await renderPdf(page, await buildDepositInvoice(page, input, fakeTenant, fakeBrand));
    expect(await page.$$eval('img[onerror]', (e) => e.length)).toBe(0);
    expect(await text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('flows a long scope onto extra pages with consistent footers', async () => {
    const extra = depositInvoiceFixture.scope.map((s) => ({ ...s, heading: `${s.heading} (additional)` }));
    const input = { ...depositInvoiceFixture, scope: [...depositInvoiceFixture.scope, ...extra, ...extra, ...extra] };
    const pdf = await renderPdf(page, await buildDepositInvoice(page, input, fakeTenant, fakeBrand));
    const count = await page.$$eval('.page', (p) => p.length);
    expect(count).toBeGreaterThan(2);
    expect(pdfPages(pdf)).toBe(count);
    const pg = await page.$$eval('.rf .pg', (els) => els.map((e) => e.textContent ?? ''));
    expect(pg).toHaveLength(count);
    pg.forEach((t, i) => expect(t).toContain(`${String(i + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}`));
  });

  it('rejects an empty scope', async () => {
    await expect(buildDepositInvoice(page, { ...depositInvoiceFixture, scope: [] }, fakeTenant, fakeBrand)).rejects.toThrow(/scope/i);
  });

  it('fails closed when the pricing page would collide with the disclaimer', async () => {
    const lines = Array.from({ length: 14 }, (_, i) => ({
      description: `Extra line ${i + 1} with a reasonably long description so it wraps`,
      kind: 'Work',
      qty: 1,
      unitNetPence: 10000,
      vatApplies: true,
    }));
    const input = { ...depositInvoiceFixture, quoteLines: lines };
    await expect(renderPdf(page, await buildDepositInvoice(page, input, fakeTenant, fakeBrand))).resolves.toBeDefined();
    // Deposit invoices show one row whatever the quote holds, so the collision risk is the notes below it. A long note must trip the guard.
    const long = { ...depositInvoiceFixture, disclaimer: 'x '.repeat(4000) };
    await expect(renderPdf(page, await buildDepositInvoice(page, long, fakeTenant, fakeBrand))).rejects.toBeInstanceOf(PageOverflowError);
  });
});

describe('balance invoice', () => {
  it('renders the balance split 1,921.50 + 384.30 = 2,305.80 with the deposit received', async () => {
    const pdf = await renderPdf(page, await buildBalanceInvoice(page, balanceInvoiceFixture, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(2);
    const t = await text();
    for (const s of ['Balance Invoice', 'INV-JS-001-B', '£1,921.50', '£384.30', '£2,305.80', '£3,294.00', '30% deposit received', '£988.20', 'receipt RCP-JS-001-D']) {
      expect(t).toContain(s);
    }
    expect(t).toContain('Payment is due upon receipt of this invoice.');
  });

  it('shows extras and credits on top of the quote', async () => {
    const input = {
      ...balanceInvoiceFixture,
      adjustmentLines: [
        { description: 'Extra ply boards', kind: 'Extra', qty: 2, unitNetPence: 5000, vatApplies: true },
        { description: 'Goodwill credit', kind: 'Credit', qty: 1, unitNetPence: -2500, vatApplies: true },
      ],
    };
    await renderPdf(page, await buildBalanceInvoice(page, input, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).toContain('Extras and credits (inc. VAT)');
    expect(t).toContain('£90.00'); // (10000 - 2500) net + 20% = 9000p
  });

  it('leaves the receipt reference out when there is none', async () => {
    const input = { ...balanceInvoiceFixture, depositReceiptRef: null };
    await renderPdf(page, await buildBalanceInvoice(page, input, fakeTenant, fakeBrand));
    expect(await text()).not.toContain('(receipt');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:render -- tests/render/invoices.test.ts`
Expected: FAIL, cannot resolve `../../src/templates/invoice`.

- [ ] **Step 3: Implement**

`src/templates/invoice.ts`:
```ts
import type { Page } from 'playwright-core';
import { html, raw } from '../lib/html';
import { balanceStatement, computeTotals, depositOf, formatGBP, type MoneyLine, type Pence } from '../lib/money';
import { documentShell } from '../pdf/document';
import type { Brand, Tenant } from '../themes/types';
import { documentCss } from './css';
import * as F from './finance-parts';
import * as P from './parts';
import { flowScope } from './scope-flow';

const FIRST_AREA_MM = 297 - 58 - 8 - 19; // below .fhead (58mm) and .fbody top padding (8mm), above the footer reserve
const REST_AREA_MM = 297 - 27 - 19; // .body: top 27mm, bottom 19mm
const BODY_WIDTH_MM = 210 - 2 * 16;

export interface InvoiceCommon {
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
  disclaimer: string;
}

export interface DepositInvoiceInput extends InvoiceCommon {
  /** For example "Before works start". */
  dueLabel: string;
}

export interface BalanceInvoiceInput extends InvoiceCommon {
  /** Extra works or credits on top of the quote. Credits have a negative unit price. */
  adjustmentLines: MoneyLine[];
  depositReceiptRef: string | null;
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
  const { items, groups } = await flowScope({
    page,
    css,
    widthMm: BODY_WIDTH_MM,
    firstAreaMm: FIRST_AREA_MM,
    restAreaMm: REST_AREA_MM,
    headFirst,
    headRest,
    sections,
  });

  const total = groups.length + 1;
  const header = P.runningHeader(tenant, brand, s.title, s.invoiceNo);
  const footer = (n: number, reserved = false) => P.runningFooter(tenant, n, total, reserved);

  const first = F.financePage(
    F.financeHeader(tenant, brand, s.title, [['Date', s.dateLabel], ['Invoice no.', s.invoiceNo], ...s.metaRows]),
    html`${headFirst}<div>${groups[0].map((i) => items[i])}</div>`,
    footer(1, true),
  );
  const continuation = groups
    .slice(1)
    .map((g, gi) => P.page(html`${headRest}<div>${g.map((i) => items[i])}</div>`, header, footer(gi + 2)));

  const pricing = P.page(
    html`<span class="eyebrow">Amount due</span><h2>Pricing &amp; payment</h2><div class="rule"></div>${s.note ? html`<div class="callout" style="margin-bottom:6mm">${s.note}</div>` : null}${P.priceTable(s.rows, s.showVat)}${P.totalsBlock(s.totalRows, s.grandLabel, formatGBP(s.grandPence), s.afterRows)}${s.guarantee ? F.compactGuaranteeBand(s.guarantee.years, s.guarantee.text) : null}<div style="margin-top:9mm">${F.payCard(s.bank, s.paymentRef)}</div><div class="terms" style="margin-top:9mm"><div class="t"><h5>Terms and conditions</h5><p>${s.terms}</p></div>${s.showVat && tenant.vatNo ? html`<div class="t"><h5>VAT registration number</h5><p class="mono">${tenant.vatNo}</p></div>` : null}</div><div class="fine" data-reserved style="position:absolute;bottom:0;left:0;right:0"><b>Important information</b>${s.disclaimer}</div>`,
    header,
    footer(total),
  );

  return documentShell({
    title: `${tenant.name} ${s.title} ${s.invoiceNo}`,
    css,
    body: raw([first, ...continuation, pricing].map((p) => p.value).join('')),
  });
}

export function buildDepositInvoice(page: Page, input: DepositInvoiceInput, tenant: Tenant, brand: Brand): Promise<string> {
  const quote = computeTotals(input.quoteLines, input.vatRateBp);
  const dep = depositOf(quote, input.depositPctBp);
  const showVat = input.quoteLines.some((l) => l.vatApplies);
  const pct = `${input.depositPctBp / 100}%`;
  const rate = `${input.vatRateBp / 100}%`;
  const balance = quote.grossPence - dep.grossPence;
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
      ['Balance due on completion', formatGBP(balance)],
    ],
    guarantee: input.guarantee,
    bank: input.bank,
    paymentRef: input.paymentRef,
    terms: `The ${pct} deposit is payable ${input.dueLabel.toLowerCase()}. The remaining balance of ${formatGBP(balance)} is due on completion of works.`,
    disclaimer: input.disclaimer,
  });
}

export function buildBalanceInvoice(page: Page, input: BalanceInvoiceInput, tenant: Tenant, brand: Brand): Promise<string> {
  const st = balanceStatement(input.quoteLines, input.adjustmentLines, input.vatRateBp, input.depositPctBp);
  const showVat = [...input.quoteLines, ...input.adjustmentLines].some((l) => l.vatApplies);
  const pct = `${input.depositPctBp / 100}%`;
  const rate = `${input.vatRateBp / 100}%`;
  const inc = showVat ? ' (inc. VAT)' : '';
  const afterRows: [string, string][] = [[`Quote total${inc}`, formatGBP(st.quote.grossPence)]];
  if (st.adjustments) afterRows.push([`Extras and credits${inc}`, formatGBP(st.adjustments.grossPence)]);
  afterRows.push([`${pct} deposit received`, formatGBP(st.deposit.grossPence)]);
  return renderInvoice(page, tenant, brand, {
    title: 'Balance Invoice',
    invoiceNo: input.invoiceNo,
    dateLabel: input.dateLabel,
    metaRows: [['Quote ref.', input.quoteRef]],
    customer: input.customer,
    due: { label: 'Total due', amountPence: st.balance.grossPence, note: 'Payment is due upon receipt of this invoice' },
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
    terms: 'Payment is due upon receipt of this invoice.',
    disclaimer: input.disclaimer,
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:render -- tests/render/invoices.test.ts && npx tsc --noEmit`
Expected: PASS. If the two-page deposit test reports more than two pages, investigate with a screenshot (use `screenshotPages` from a scratch script) before changing constants; if `PageOverflowError` is thrown for the fixture, the capacity constants `FIRST_AREA_MM` or the 8mm and 19mm reserves are wrong, so measure and report rather than weakening the guard. If the collision test (`x ` repeated) does not throw, make the disclaimer longer until it does, and report what length was needed.

- [ ] **Step 5: Commit**

```bash
git add src/templates/invoice.ts tests/fixtures/invoices.ts tests/render/invoices.test.ts
git commit -m "feat: deposit and balance invoice templates"
```

---

### Task 5: Receipt

**Files:**
- Create: `src/templates/receipt.ts`, `tests/fixtures/receipts.ts`
- Test: `tests/render/receipt.test.ts`

**Interfaces:**
- Consumes: `balanceDue`, `formatGBP`, `Pence`; `documentCss`, `documentShell`; finance parts; `priceTable`, `totalsBlock`.
- Produces:
  - `interface ReceiptInput { receiptNo: string; invoiceRef: string; quoteRef: string; paidDateLabel: string; customer: Customer; kind: 'deposit' | 'balance'; description: string; method: string; amountPaidPence: Pence; previousPaymentsPence: Pence[]; quoteGrossPence: Pence; vatIncluded: boolean }` (`paidDateLabel` is `dd/mm/yyyy`)
  - `buildReceipt(input: ReceiptInput, tenant: Tenant, brand: Brand): string` returning a full single-page HTML document. Balance remaining is computed with `balanceDue`. The stamp reads "Paid in full" when the balance is zero, otherwise "Deposit" (kind deposit) or "Part payment".

- [ ] **Step 1: Write the fixtures and failing tests**

`tests/fixtures/receipts.ts`:
```ts
import type { ReceiptInput } from '../../src/templates/receipt';
import { customer } from './common';

export const depositReceiptFixture: ReceiptInput = {
  receiptNo: 'RCP-JS-001-D',
  invoiceRef: 'INV-JS-001-D',
  quoteRef: 'QT-JS-001',
  paidDateLabel: '07/10/2026',
  customer,
  kind: 'deposit',
  description: '30% Deposit – flat roof replacement (inc. VAT)',
  method: 'Bank transfer',
  amountPaidPence: 98820,
  previousPaymentsPence: [],
  quoteGrossPence: 329400,
  vatIncluded: true,
};

export const finalReceiptFixture: ReceiptInput = {
  ...depositReceiptFixture,
  receiptNo: 'RCP-JS-001-B',
  invoiceRef: 'INV-JS-001-B',
  paidDateLabel: '11/10/2026',
  kind: 'balance',
  description: 'Balance payment – flat roof replacement (inc. VAT)',
  amountPaidPence: 230580,
  previousPaymentsPence: [98820],
};
```

`tests/render/receipt.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { PageOverflowError, renderPdf } from '../../src/pdf/render';
import { buildReceipt } from '../../src/templates/receipt';
import { fakeBrand, fakeTenant } from '../fixtures/fake';
import { depositReceiptFixture, finalReceiptFixture } from '../fixtures/receipts';

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

describe('receipt', () => {
  it('deposit receipt: one page, amount paid, balance remaining £2,305.80, deposit stamp', async () => {
    const pdf = await renderPdf(page, buildReceipt(depositReceiptFixture, fakeTenant, fakeBrand));
    expect(pdfPages(pdf)).toBe(1);
    const t = await text();
    for (const s of ['Receipt', 'RCP-JS-001-D', 'INV-JS-001-D', '£988.20', '£2,305.80', 'Bank transfer', 'DEPOSIT', '07 · 10 · 2026']) {
      expect(t.toUpperCase()).toContain(s.toUpperCase());
    }
    expect(t).toContain('due on completion of works (quote QT-JS-001, total £3,294.00 inc. VAT)');
    expect(t).toContain('GB 408094403');
  });

  it('final receipt: balance £0.00 and a paid-in-full stamp', async () => {
    await renderPdf(page, buildReceipt(finalReceiptFixture, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).toContain('£2,305.80');
    expect(t).toContain('£0.00');
    expect(t.toUpperCase()).toContain('PAID IN FULL');
    expect(t).toContain('Paid in full – no balance outstanding (quote QT-JS-001, total £3,294.00 inc. VAT).');
  });

  it('a part payment on the balance is not marked paid in full', async () => {
    const input = { ...finalReceiptFixture, amountPaidPence: 100000 };
    await renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand));
    const t = await text();
    expect(t.toUpperCase()).toContain('PART PAYMENT');
    expect(t).toContain('£1,305.80');
    expect(t).toContain('still outstanding');
  });

  it('rejects payments that exceed the quote total', () => {
    expect(() => buildReceipt({ ...finalReceiptFixture, amountPaidPence: 999999 }, fakeTenant, fakeBrand)).toThrow(RangeError);
  });

  it('omits the VAT number when the figures do not include VAT', async () => {
    const input = { ...depositReceiptFixture, vatIncluded: false, description: '30% Deposit – flat roof replacement' };
    await renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand));
    const t = await text();
    expect(t).not.toContain('VAT registration number');
    expect(t).not.toContain('inc. VAT');
  });

  it('escapes customer text', async () => {
    const input = { ...depositReceiptFixture, customer: { ...depositReceiptFixture.customer, name: '<img src=x onerror=alert(1)>' } };
    await renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand));
    expect(await page.$$eval('img[onerror]', (e) => e.length)).toBe(0);
  });

  it('fails closed when content runs into the footer', async () => {
    const input = { ...depositReceiptFixture, description: 'Very long description '.repeat(400) };
    await expect(renderPdf(page, buildReceipt(input, fakeTenant, fakeBrand))).rejects.toBeInstanceOf(PageOverflowError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:render -- tests/render/receipt.test.ts`
Expected: FAIL, cannot resolve `../../src/templates/receipt`.

- [ ] **Step 3: Implement**

`src/templates/receipt.ts`:
```ts
import { html, raw } from '../lib/html';
import { balanceDue, formatGBP, type Pence } from '../lib/money';
import { documentShell } from '../pdf/document';
import type { Brand, Tenant } from '../themes/types';
import { documentCss } from './css';
import * as F from './finance-parts';
import * as P from './parts';

export interface ReceiptInput {
  receiptNo: string;
  invoiceRef: string;
  quoteRef: string;
  /** dd/mm/yyyy */
  paidDateLabel: string;
  customer: F.Customer;
  kind: 'deposit' | 'balance';
  description: string;
  method: string;
  amountPaidPence: Pence;
  previousPaymentsPence: Pence[];
  quoteGrossPence: Pence;
  vatIncluded: boolean;
}

export function buildReceipt(input: ReceiptInput, tenant: Tenant, brand: Brand): string {
  const remaining = balanceDue(input.quoteGrossPence, [...input.previousPaymentsPence, input.amountPaidPence]);
  const paidInFull = remaining === 0;
  const stampLabel = paidInFull ? 'Paid in full' : input.kind === 'deposit' ? 'Deposit' : 'Part payment';
  const stampDate = input.paidDateLabel.split('/').join(' · ');
  const outstanding = input.kind === 'deposit' ? 'due on completion of works' : 'still outstanding';
  const amount = formatGBP(input.amountPaidPence);
  const quoteTotal = `total ${formatGBP(input.quoteGrossPence)}${input.vatIncluded ? ' inc. VAT' : ''}`;
  const remainingText = paidInFull
    ? `Paid in full – no balance outstanding (quote ${input.quoteRef}, ${quoteTotal}).`
    : `${formatGBP(remaining)} – ${outstanding} (quote ${input.quoteRef}, ${quoteTotal}).`;
  const remainingNote = paidInFull ? 'Paid in full' : input.kind === 'deposit' ? 'Due on completion of works' : 'Still outstanding';
  const row = {
    description: input.description,
    kind: input.kind === 'deposit' ? 'Deposit' : 'Balance',
    qty: '1',
    unit: amount,
    vat: '',
    total: amount,
  };

  const inner = html`<div class="parties" style="align-items:center">${F.partyBlock('Received from', input.customer)}<div style="display:flex;justify-content:flex-end;padding-right:6mm"><div class="stamp"><div class="b">${stampLabel}</div><div class="a">PAID</div><div class="b">${stampDate}</div></div></div></div><div class="panel" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6mm;border-top:1mm solid var(--gold);margin-bottom:7mm"><div><span class="eyebrow">Amount paid</span><div class="serif" style="font-size:22pt;color:var(--navy);margin-top:1.5mm">${amount}</div></div><div><span class="eyebrow">Payment method</span><div class="serif" style="font-size:13pt;margin-top:3mm">${input.method}</div></div><div><span class="eyebrow">Balance remaining</span><div class="serif" style="font-size:13pt;margin-top:3mm">${formatGBP(remaining)}</div><div class="small">${remainingNote}</div></div></div><div class="sechead"><span class="eyebrow">Payment received</span><h3>Receipt details</h3></div>${P.priceTable([row], false)}${P.totalsBlock([], 'Amount paid', amount)}<div class="terms" style="margin-top:9mm"><div class="t"><h5>Balance remaining</h5><p>${remainingText}</p></div>${input.vatIncluded && tenant.vatNo ? html`<div class="t"><h5>VAT registration number</h5><p class="mono">${tenant.vatNo}</p></div>` : null}</div><div class="callout" style="margin-top:9mm;border-left-color:var(--navy);background:var(--ice)">This receipt confirms payment has been received against the invoice referenced above. Please retain this receipt for your records.</div>`;

  const doc = F.financePage(
    F.financeHeader(tenant, brand, 'Receipt', [['Date paid', input.paidDateLabel], ['Receipt no.', input.receiptNo], ['Invoice ref.', input.invoiceRef]]),
    inner,
    F.financeFooter(tenant),
  );
  return documentShell({ title: `${tenant.name} Receipt ${input.receiptNo}`, css: documentCss(brand), body: raw(doc.value) });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:render -- tests/render/receipt.test.ts && npx tsc --noEmit`
Expected: PASS. If the overflow test does not throw, lengthen the description until the collision with `.ffoot` or the page edge occurs, and report the length needed.

- [ ] **Step 5: Commit**

```bash
git add src/templates/receipt.ts tests/fixtures/receipts.ts tests/render/receipt.test.ts
git commit -m "feat: receipt template (deposit, part payment, paid in full)"
```

---

### Task 6: Guarantee certificate

**Files:**
- Create: `src/templates/guarantee.ts`, `tests/fixtures/guarantee.ts`
- Test: `tests/render/guarantee.test.ts`

**Interfaces:**
- Consumes: `html`, `raw`; `documentCss`, `documentShell`; `Tenant`, `Brand`.
- Produces:
  - `interface GuaranteeInput { certificateNo: string; years: number; workDescription: string; address: string; completedLabel: string; statement: string; disclaimerLine: string | null }`
  - `buildGuarantee(input: GuaranteeInput, tenant: Tenant, brand: Brand): string` returning a one-page HTML document. The wording (`statement`, `disclaimerLine`) comes from input only. The circular seal text is sized to the circle with `textLength` so it cannot overlap itself (the reference sample's seal text overlaps).

- [ ] **Step 1: Write the fixtures and failing tests**

`tests/fixtures/guarantee.ts`:
```ts
import type { GuaranteeInput } from '../../src/templates/guarantee';

export const guaranteeFixture: GuaranteeInput = {
  certificateNo: 'GC-JS-001',
  years: 20,
  workDescription: 'dormer flat roof',
  address: '123 Bromley Road, Bromley, BR2 8BG',
  completedLabel: '06/10/2026',
  statement: 'Any defect in installation that occurs within this period will be repaired at no cost to the customer.',
  disclaimerLine: 'We cannot be held responsible for misuse of our products by the customer',
};
```

`tests/render/guarantee.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
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
      'GC-JS-001',
      'Ben Cunningham',
      'COMPANY NO. 13855379',
    ]) {
      expect(t).toContain(s);
    }
    expect(t.toUpperCase()).toContain('WE CANNOT BE HELD RESPONSIBLE FOR MISUSE OF OUR PRODUCTS BY THE CUSTOMER');
  });

  it('seal text names the business and the years and is sized to the circle', async () => {
    await renderPdf(page, buildGuarantee(guaranteeFixture, fakeTenant, fakeBrand));
    const seal = await page.$eval('svg textPath', (el) => ({ text: el.textContent ?? '', length: el.getAttribute('textLength') }));
    expect(seal.text).toContain('FJC ROOFING LTD');
    expect(seal.text).toContain('20 YEAR GUARANTEE');
    expect(Number(seal.length)).toBeGreaterThan(400);
    expect(Number(seal.length)).toBeLessThan(465);
  });

  it('leaves the disclaimer line out when none is given', async () => {
    await renderPdf(page, buildGuarantee({ ...guaranteeFixture, disclaimerLine: null }, fakeTenant, fakeBrand));
    expect((await text()).toUpperCase()).not.toContain('MISUSE');
  });

  it('escapes input text, including inside the seal', async () => {
    const tenant = { ...fakeTenant, name: 'A <b>&</b> Co' };
    const input = { ...guaranteeFixture, address: '<img src=x onerror=alert(1)>' };
    await renderPdf(page, buildGuarantee(input, tenant, fakeBrand));
    expect(await page.$$eval('img[onerror], svg b', (e) => e.length)).toBe(0);
  });

  it('fails closed when the content does not fit the frame', async () => {
    const input = { ...guaranteeFixture, address: 'A very long address line '.repeat(60) };
    await expect(renderPdf(page, buildGuarantee(input, fakeTenant, fakeBrand))).rejects.toBeInstanceOf(PageOverflowError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:render -- tests/render/guarantee.test.ts`
Expected: FAIL, cannot resolve `../../src/templates/guarantee`.

- [ ] **Step 3: Implement**

`src/templates/guarantee.ts`:
```ts
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
}

// Circumference of the r=74 text circle, minus a little so the end never touches the start.
const SEAL_TEXT_LENGTH = 458;

function seal(t: Tenant, years: number): Raw {
  const label = `${t.name.toUpperCase()} · ${years} YEAR GUARANTEE · `;
  return html`<svg viewBox="0 0 200 200" width="46mm" height="46mm" role="img" aria-label="${years} year guarantee seal"><defs><path id="seal-arc" d="M100,100 m-74,0 a74,74 0 1,1 148,0 a74,74 0 1,1 -148,0"/></defs><circle cx="100" cy="100" r="96" style="fill:var(--navy)"/><circle cx="100" cy="100" r="89" style="fill:none;stroke:var(--gold);stroke-width:1.6"/><circle cx="100" cy="100" r="60" style="fill:none;stroke:var(--gold);stroke-width:.8"/><text style="font-family:Mono;font-size:10px;fill:var(--gold2)"><textPath href="#seal-arc" textLength="${SEAL_TEXT_LENGTH}" lengthAdjust="spacing">${label}</textPath></text><text x="100" y="113" text-anchor="middle" style="font-family:Playfair;font-weight:600;font-size:50px;fill:#fff">${years}</text><text x="100" y="134" text-anchor="middle" style="font-family:Mono;font-size:8.5px;letter-spacing:3px;fill:var(--gold)">YEARS</text></svg>`;
}

export function buildGuarantee(input: GuaranteeInput, tenant: Tenant, brand: Brand): string {
  const inner = html`<section class="page"><div class="cert"><div class="frame"></div><div class="in" data-fit><img src="${brand.assets.logoColour}" alt="${tenant.name}" style="height:21mm"><span class="eyebrow g" style="margin-top:5mm;letter-spacing:.34em">${tenant.tagline}</span><div style="font-family:Playfair;font-size:14pt;color:var(--muted);margin-top:11mm;font-style:italic">Certificate of</div><h1 style="font-size:40pt;color:var(--navy);margin-top:1mm">Guarantee</h1><div class="rule g" style="margin:5mm auto 7mm;width:24mm"></div><p style="font-size:10pt;color:var(--body)">This certifies that the ${input.workDescription} installed at</p><div class="serif" style="font-size:19pt;margin:2mm 0 2mm">${input.address}</div><p style="font-size:10pt">was installed by <b style="font-family:Playfair;font-size:12pt;color:var(--navy)">${tenant.name}</b></p><div style="margin:8mm 0 4mm">${seal(tenant, input.years)}</div><span class="eyebrow" style="font-size:7.4pt">${input.years} Year Guarantee</span><div class="mono" style="margin-top:6mm;font-size:8pt;color:var(--ink);border-top:.3mm solid var(--gold2);border-bottom:.3mm solid var(--gold2);padding:2.2mm 8mm">INSTALLATION COMPLETED · ${input.completedLabel}</div><p style="font-size:9.6pt;max-width:130mm;margin-top:7mm;line-height:1.6">${input.statement}</p>${input.disclaimerLine ? html`<div class="mono" style="font-size:6.4pt;letter-spacing:.14em;color:var(--muted);margin-top:3mm">${input.disclaimerLine.toUpperCase()}</div>` : null}<div style="flex:1"></div><div style="width:100%;display:flex;justify-content:space-between;align-items:flex-end;text-align:left"><div class="sign"><div class="s"><img src="${brand.assets.signature}" alt="Signature of ${tenant.ownerName}"><div class="line"><div class="nm">${tenant.ownerName}</div><div class="rl">Authorised signature · ${tenant.ownerTitle}</div></div></div></div><div style="text-align:right" class="mono"><div style="font-size:7pt;color:var(--ink)">${tenant.web}</div><div style="font-size:7pt;color:var(--ink)">${tenant.email}</div><div style="font-size:6pt;color:var(--muted);letter-spacing:.14em;margin-top:1mm">CERTIFICATE NO. ${input.certificateNo}</div><div style="font-size:6pt;color:var(--muted);letter-spacing:.14em">COMPANY NO. ${tenant.companyNo}</div></div></div></div></div></section>`;
  return documentShell({
    title: `${tenant.name} Guarantee ${input.certificateNo}`,
    css: documentCss(brand),
    body: raw(inner.value),
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:render -- tests/render/guarantee.test.ts && npx tsc --noEmit`
Expected: PASS. The `data-fit` flag on `.in` is what makes the overflow test throw. If it does not, check that `scrollHeight` of the flex container exceeds `clientHeight` with the long address and report what you find.

- [ ] **Step 5: Commit**

```bash
git add src/templates/guarantee.ts tests/fixtures/guarantee.ts tests/render/guarantee.test.ts
git commit -m "feat: guarantee certificate template with non-overlapping seal text"
```

---

### Task 7: Render every document for review

**Files:**
- Modify: `scripts/render-spike.ts`

**Interfaces:**
- Consumes: all builders and fixtures; `launchBrowser`, `newLockedPage`, `renderPdf`, `screenshotPages`; `loadFjcBrand`, `fjcTenant`.
- Produces: `out/<name>/<name>.pdf` and `out/<name>/page-NN.png` for `quotation`, `deposit-invoice`, `balance-invoice`, `receipt-deposit`, `receipt-paid-in-full`, `guarantee`.

- [ ] **Step 1: Rewrite the script**

`scripts/render-spike.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchBrowser, newLockedPage } from '../src/pdf/browser';
import { renderPdf, screenshotPages } from '../src/pdf/render';
import { buildGuarantee } from '../src/templates/guarantee';
import { buildBalanceInvoice, buildDepositInvoice } from '../src/templates/invoice';
import { buildQuotation } from '../src/templates/quotation';
import { buildReceipt } from '../src/templates/receipt';
import { fjcTenant, loadFjcBrand } from '../tests/fixtures/fjc';
import { guaranteeFixture } from '../tests/fixtures/guarantee';
import { balanceInvoiceFixture, depositInvoiceFixture } from '../tests/fixtures/invoices';
import { quotationFixture } from '../tests/fixtures/quotation';
import { depositReceiptFixture, finalReceiptFixture } from '../tests/fixtures/receipts';

async function main() {
  const brand = loadFjcBrand();
  const browser = await launchBrowser();
  try {
    const page = await newLockedPage(browser);
    const docs: [string, () => Promise<string> | string][] = [
      ['quotation', () => buildQuotation(page, quotationFixture, fjcTenant, brand)],
      ['deposit-invoice', () => buildDepositInvoice(page, depositInvoiceFixture, fjcTenant, brand)],
      ['balance-invoice', () => buildBalanceInvoice(page, balanceInvoiceFixture, fjcTenant, brand)],
      ['receipt-deposit', () => buildReceipt(depositReceiptFixture, fjcTenant, brand)],
      ['receipt-paid-in-full', () => buildReceipt(finalReceiptFixture, fjcTenant, brand)],
      ['guarantee', () => buildGuarantee(guaranteeFixture, fjcTenant, brand)],
    ];
    for (const [name, build] of docs) {
      const dir = `out/${name}`;
      mkdirSync(dir, { recursive: true });
      const doc = await build();
      writeFileSync(`${dir}/${name}.pdf`, await renderPdf(page, doc));
      const files = await screenshotPages(page, doc, dir);
      console.log(`${name}: ${files.length} page(s)`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

Run: `npm run spike`
Expected: prints `quotation: 4 page(s)`, `deposit-invoice: 2 page(s)`, `balance-invoice: 2 page(s)`, `receipt-deposit: 1 page(s)`, `receipt-paid-in-full: 1 page(s)`, `guarantee: 1 page(s)`.

- [ ] **Step 3: Run the full suite and commit**

```bash
npm test && npm run test:render && npx tsc --noEmit && npm run build
git add scripts/render-spike.ts
git commit -m "feat: render all document types in the spike script"
```
Expected: everything passes. Do not commit `out/`. The controller reviews every page image against the matching reference PDF (`FJC_09` to `FJC_13`) after this task.

---

## Out of scope for this plan (later plans)

- Survey report (cover, findings with photos, conclusion) and photo handling.
- Optional guarantee terms list (the ten-item list used by Top Choice) and the completion certificate.
- Bullet-level splitting of a single over-tall scope section (the paginator still throws).
- Plan 2 (Supabase, auth, TOTP, RLS), AI scope writing, owner UI, purge job, seed data.
