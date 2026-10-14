# Foundation, Money and Render Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Next.js app skeleton, a unit-tested money library, a safe HTML templating helper, a locked-down Chromium PDF pipeline with page-overflow detection and automatic scope pagination, and the FJC quotation rendered to a real A4 PDF from dummy data.

**Architecture:** Pure TypeScript libraries (`money`, `html`, `paginate`) have no browser dependency and are unit tested. The PDF layer wraps `playwright-core` driving a local Chrome in a network-blocked page. Templates are TypeScript functions that return escaped HTML, styled by the FJC `base.css` ported from the reference with colours injected as CSS variables from a brand object.

**Tech Stack:** Next.js (App Router), TypeScript, Vitest, zod, playwright-core, @fontsource (Playfair Display, Inter, JetBrains Mono), tsx.

**Spec:** `docs/superpowers/specs/2026-10-14-docportal-design.md`

## Global Constraints

- Node v24 on macOS. No Homebrew, no Docker, no poppler. Page checks use Chromium screenshots, never pdf.js.
- Money is integer pence only. VAT is per line, rounded half away from zero (half-up for positive amounts), then summed. A deposit is its percentage of the ex-VAT subtotal and of the VAT. The AI never calculates money.
- Percentages and rates are basis points (20% VAT is `2000`, a 30% deposit is `3000`).
- All HTML is built with the `html` tagged template so interpolated values are escaped. Only `raw()` bypasses it, and only for trusted markup.
- Documents are A4, 210mm by 297mm, fixed pages with a fixed footer.
- Fixtures use dummy data only: Mr John Smith, 123 Bromley Road, BR2 8BG, john.smith@example.com, bank 00-00-00 / 00000000. FJC business details (company name, company number, public contact) are allowed. Never use real customer names, emails, phones or bank numbers.
- Never commit `reference/`, `out/`, `.env*`, keys or any client personal data.
- Use relative imports (no path aliases) so `tsx` and Vitest need no extra config.
- UK English in all copy. No em dashes in code comments or copy.
- Commit locally only. Alfie pushes with GitHub Desktop.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `vitest.render.config.ts` | Tooling |
| `src/app/layout.tsx`, `src/app/page.tsx` | Placeholder portal page (noindex) so Vercel has something to build |
| `src/lib/money.ts` | Integer-pence VAT, totals, deposit, balance, GBP formatting |
| `src/lib/html.ts` | `html` tagged template, `raw()`, `Raw` |
| `src/pdf/assets.ts` | Base64 font CSS and `dataUri()` for images |
| `src/pdf/document.ts` | `documentShell()` page wrapper with a strict CSP meta |
| `src/pdf/browser.ts` | Launch Chrome, create a network-blocked page |
| `src/pdf/render.ts` | `renderPdf`, `screenshotPages`, `assertNoOverflow` |
| `src/pdf/measure.ts` | Measure fragment heights in the browser |
| `src/pdf/paginate.ts` | Pure greedy pagination |
| `src/themes/types.ts`, `src/themes/theme.ts`, `src/themes/fjc/base.css` | Brand types, CSS variables, ported FJC stylesheet |
| `src/templates/parts.ts` | Shared document components |
| `src/templates/quotation.ts` | Quotation builder |
| `tests/unit/*.test.ts` | Fast tests, no browser |
| `tests/render/*.test.ts` | Chromium tests |
| `tests/fixtures/*.ts` | Dummy data and asset loading |
| `scripts/render-spike.ts` | Renders the quotation to `out/` for human review |

---

### Task 1: Scaffold the Next.js app and test runners

**Files:**
- Create: `package.json` (via npm), `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `vitest.render.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `.env.example`, `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `start`, `typecheck`, `test` (unit), `test:render` (Chromium), `spike`.

- [ ] **Step 1: Install dependencies**

```bash
cd "/Users/alfie/Documents/TradesPro DocPortal"
npm init -y
npm i next react react-dom zod playwright-core @fontsource/playfair-display @fontsource/inter @fontsource/jetbrains-mono
npm i -D typescript vitest tsx @types/node @types/react @types/react-dom
npm pkg set name=tradespro-docportal private=true
npm pkg set scripts.dev="next dev" scripts.build="next build" scripts.start="next start"
npm pkg set scripts.typecheck="tsc --noEmit"
npm pkg set scripts.test="vitest run --passWithNoTests"
npm pkg set scripts.test:render="vitest run -c vitest.render.config.ts"
npm pkg set scripts.spike="tsx scripts/render-spike.ts"
```

- [ ] **Step 2: Write config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "reference", "out"]
}
```

`next.config.ts`:
```ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
};

export default config;
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/unit/**/*.test.ts'] },
});
```

`vitest.render.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/render/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
```

`src/app/layout.tsx`:
```tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'TradesPro DocPortal',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
```

`src/app/page.tsx`:
```tsx
export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>TradesPro DocPortal</h1>
      <p>Coming soon.</p>
    </main>
  );
}
```

`.env.example`:
```
# Copy to .env.local. Never commit real values.
CHROMIUM_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

`README.md`:
```markdown
# TradesPro DocPortal

Branded trade paperwork from a short form. See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the build plans.

## Scripts

- `npm test` runs fast unit tests.
- `npm run test:render` runs Chromium rendering tests. It needs Chrome and the reference zip extracted to `reference/` (see below).
- `npm run spike` renders the quotation to `out/`.

## Reference material (not committed)

```bash
mkdir -p reference && unzip -q ~/Downloads/DocPortal_Reference.zip -d reference
```
```

Append to `.gitignore`:
```
out/
next-env.d.ts
*.tsbuildinfo
```

- [ ] **Step 3: Verify build and test commands**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck passes, vitest reports no test files (passes), `next build` succeeds and lists the `/` route.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js app with unit and render test runners"
```

---

### Task 2: Money library

**Files:**
- Create: `src/lib/money.ts`
- Test: `tests/unit/money.test.ts`

**Interfaces:**
- Produces:
  - `type Pence = number`
  - `interface MoneyLine { description: string; kind: string; qty: number; unitNetPence: Pence; vatApplies: boolean }`
  - `interface PricedLine extends MoneyLine { netPence: Pence; vatPence: Pence; grossPence: Pence }`
  - `interface Totals { lines: PricedLine[]; netPence: Pence; vatPence: Pence; grossPence: Pence }`
  - `mulDivRound(value: number, num: number, den: number): number`
  - `vatOnNet(netPence: Pence, rateBp: number): Pence`
  - `priceLine(line: MoneyLine, rateBp: number): PricedLine`
  - `computeTotals(lines: MoneyLine[], rateBp: number): Totals`
  - `depositOf(totals: Totals, pctBp: number): { netPence: Pence; vatPence: Pence; grossPence: Pence }`
  - `balanceDue(quoteGrossPence: Pence, receivedPence: Pence[]): Pence`
  - `formatGBP(pence: Pence): string`

- [ ] **Step 1: Write the failing tests**

`tests/unit/money.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  balanceDue,
  computeTotals,
  depositOf,
  formatGBP,
  mulDivRound,
  priceLine,
  vatOnNet,
  type MoneyLine,
} from '../../src/lib/money';

const line = (unitNetPence: number, over: Partial<MoneyLine> = {}): MoneyLine => ({
  description: 'Work',
  kind: 'Work',
  qty: 1,
  unitNetPence,
  vatApplies: true,
  ...over,
});

describe('mulDivRound', () => {
  it('rounds half up for positive values', () => {
    expect(mulDivRound(10, 500, 10000)).toBe(1); // 0.5 -> 1
    expect(mulDivRound(9, 500, 10000)).toBe(0); // 0.45 -> 0
    expect(mulDivRound(11, 500, 10000)).toBe(1); // 0.55 -> 1
  });
  it('rounds half away from zero for negative values', () => {
    expect(mulDivRound(-10, 500, 10000)).toBe(-1);
    expect(mulDivRound(-9, 500, 10000)).toBe(0);
  });
  it('rejects non-integers', () => {
    expect(() => mulDivRound(10.5, 500, 10000)).toThrow(RangeError);
  });
  it('rejects a zero or negative divisor', () => {
    expect(() => mulDivRound(10, 500, 0)).toThrow(RangeError);
  });
});

describe('vatOnNet', () => {
  it('is 20% of net at 2000bp', () => {
    expect(vatOnNet(735500, 2000)).toBe(147100);
  });
});

describe('priceLine', () => {
  it('multiplies quantity and adds VAT', () => {
    const p = priceLine(line(30000, { qty: 3 }), 2000);
    expect(p.netPence).toBe(90000);
    expect(p.vatPence).toBe(18000);
    expect(p.grossPence).toBe(108000);
  });
  it('charges no VAT when vatApplies is false', () => {
    const p = priceLine(line(10000, { vatApplies: false }), 2000);
    expect(p.vatPence).toBe(0);
    expect(p.grossPence).toBe(10000);
  });
  it('rejects fractional pence', () => {
    expect(() => priceLine(line(10.5), 2000)).toThrow(RangeError);
  });
  it('rejects a non-integer or zero quantity', () => {
    expect(() => priceLine(line(100, { qty: 0 }), 2000)).toThrow(RangeError);
    expect(() => priceLine(line(100, { qty: 1.5 }), 2000)).toThrow(RangeError);
  });
});

describe('computeTotals', () => {
  it('reproduces the residential flat roof quote: net 7,505.00, VAT 1,501.00, total 9,006.00', () => {
    const t = computeTotals([line(735500), line(15000)], 2000);
    expect(t.lines.map((l) => l.grossPence)).toEqual([882600, 18000]);
    expect(t.netPence).toBe(750500);
    expect(t.vatPence).toBe(150100);
    expect(t.grossPence).toBe(900600);
  });
  it('supports a negative discount line', () => {
    const t = computeTotals([line(100000), line(-10000)], 2000);
    expect(t.netPence).toBe(90000);
    expect(t.vatPence).toBe(18000);
    expect(t.grossPence).toBe(108000);
  });
  it('line gross values always sum to the total', () => {
    const t = computeTotals([line(3333), line(1), line(4999), line(2)], 2000);
    expect(t.lines.reduce((s, l) => s + l.grossPence, 0)).toBe(t.grossPence);
  });
});

describe('depositOf and balanceDue', () => {
  it('30% deposit on a 3,294.00 quote is 988.20 and the balance is 2,305.80', () => {
    const t = computeTotals([line(274500)], 2000);
    expect(t.grossPence).toBe(329400);
    const d = depositOf(t, 3000);
    expect(d.netPence).toBe(82350);
    expect(d.vatPence).toBe(16470);
    expect(d.grossPence).toBe(98820);
    expect(balanceDue(t.grossPence, [d.grossPence])).toBe(230580);
  });
  it('deposit plus balance equals the quote total', () => {
    const t = computeTotals([line(123457)], 2000);
    const d = depositOf(t, 2500);
    expect(d.grossPence + balanceDue(t.grossPence, [d.grossPence])).toBe(t.grossPence);
  });
  it('rejects payments that exceed the quote total', () => {
    expect(() => balanceDue(1000, [600, 600])).toThrow(RangeError);
  });
  it('is zero when paid in full', () => {
    expect(balanceDue(1000, [400, 600])).toBe(0);
  });
});

describe('formatGBP', () => {
  it('formats pounds and pence with grouping', () => {
    expect(formatGBP(900600)).toBe('£9,006.00');
    expect(formatGBP(5)).toBe('£0.05');
    expect(formatGBP(100000000)).toBe('£1,000,000.00');
  });
  it('formats negatives with a leading minus', () => {
    expect(formatGBP(-153600)).toBe('-£1,536.00');
  });
  it('rejects non-integers', () => {
    expect(() => formatGBP(1.5)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/money.test.ts`
Expected: FAIL, cannot resolve `../../src/lib/money`.

- [ ] **Step 3: Implement**

`src/lib/money.ts`:
```ts
export type Pence = number;

export interface MoneyLine {
  description: string;
  kind: string;
  qty: number;
  unitNetPence: Pence;
  vatApplies: boolean;
}

export interface PricedLine extends MoneyLine {
  netPence: Pence;
  vatPence: Pence;
  grossPence: Pence;
}

export interface Totals {
  lines: PricedLine[];
  netPence: Pence;
  vatPence: Pence;
  grossPence: Pence;
}

function assertInt(n: number, label: string): void {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${label} must be a whole number, got ${n}`);
  }
}

/** value * num / den, rounded half away from zero, using integer arithmetic only. */
export function mulDivRound(value: number, num: number, den: number): number {
  assertInt(value, 'value');
  assertInt(num, 'numerator');
  assertInt(den, 'denominator');
  if (den <= 0) throw new RangeError('denominator must be positive');
  if (num < 0) throw new RangeError('numerator must not be negative');
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  return sign * Math.floor((abs * num * 2 + den) / (den * 2));
}

export function vatOnNet(netPence: Pence, rateBp: number): Pence {
  return mulDivRound(netPence, rateBp, 10000);
}

export function priceLine(line: MoneyLine, rateBp: number): PricedLine {
  assertInt(line.qty, 'quantity');
  if (line.qty < 1) throw new RangeError('quantity must be at least 1');
  assertInt(line.unitNetPence, 'unit price');
  const netPence = line.qty * line.unitNetPence;
  const vatPence = line.vatApplies ? vatOnNet(netPence, rateBp) : 0;
  return { ...line, netPence, vatPence, grossPence: netPence + vatPence };
}

export function computeTotals(lines: MoneyLine[], rateBp: number): Totals {
  const priced = lines.map((l) => priceLine(l, rateBp));
  const netPence = priced.reduce((s, l) => s + l.netPence, 0);
  const vatPence = priced.reduce((s, l) => s + l.vatPence, 0);
  return { lines: priced, netPence, vatPence, grossPence: netPence + vatPence };
}

export function depositOf(totals: Totals, pctBp: number) {
  const netPence = mulDivRound(totals.netPence, pctBp, 10000);
  const vatPence = mulDivRound(totals.vatPence, pctBp, 10000);
  return { netPence, vatPence, grossPence: netPence + vatPence };
}

export function balanceDue(quoteGrossPence: Pence, receivedPence: Pence[]): Pence {
  assertInt(quoteGrossPence, 'quote total');
  receivedPence.forEach((p) => assertInt(p, 'payment'));
  const remaining = quoteGrossPence - receivedPence.reduce((s, p) => s + p, 0);
  if (remaining < 0) throw new RangeError('Payments exceed the quote total');
  return remaining;
}

export function formatGBP(pence: Pence): string {
  assertInt(pence, 'amount');
  const abs = Math.abs(pence);
  const pounds = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = String(abs % 100).padStart(2, '0');
  return `${pence < 0 ? '-' : ''}£${pounds}.${rest}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/money.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money.ts tests/unit/money.test.ts
git commit -m "feat: integer-pence money library with VAT, deposit and balance"
```

---

### Task 3: Safe HTML templating

**Files:**
- Create: `src/lib/html.ts`
- Test: `tests/unit/html.test.ts`

**Interfaces:**
- Produces:
  - `class Raw { readonly value: string }`
  - `raw(s: string): Raw`
  - `html(strings: TemplateStringsArray, ...values: unknown[]): Raw` (escapes strings and numbers, passes `Raw` through, flattens arrays, renders `null`, `undefined` and `false` as empty)

- [ ] **Step 1: Write the failing tests**

`tests/unit/html.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { html, raw } from '../../src/lib/html';

describe('html', () => {
  it('escapes interpolated strings', () => {
    const evil = `<script>alert("x")</script> & 'q'`;
    expect(html`<p>${evil}</p>`.value).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>',
    );
  });
  it('escapes values placed in attributes', () => {
    expect(html`<img alt="${'a" onerror="x'}">`.value).toBe('<img alt="a&quot; onerror=&quot;x">');
  });
  it('does not double-escape nested html', () => {
    const inner = html`<b>${'a & b'}</b>`;
    expect(html`<p>${inner}</p>`.value).toBe('<p><b>a &amp; b</b></p>');
  });
  it('flattens arrays of values', () => {
    const items = ['a', 'b'].map((x) => html`<li>${x}</li>`);
    expect(html`<ul>${items}</ul>`.value).toBe('<ul><li>a</li><li>b</li></ul>');
  });
  it('renders null, undefined and false as nothing', () => {
    expect(html`<p>${null}${undefined}${false}</p>`.value).toBe('<p></p>');
  });
  it('renders numbers', () => {
    expect(html`<p>${42}</p>`.value).toBe('<p>42</p>');
  });
  it('passes raw markup through untouched', () => {
    expect(html`<p>${raw('<br>')}</p>`.value).toBe('<p><br></p>');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/html.test.ts`
Expected: FAIL, cannot resolve `../../src/lib/html`.

- [ ] **Step 3: Implement**

`src/lib/html.ts`:
```ts
export class Raw {
  constructor(readonly value: string) {}
}

export const raw = (s: string): Raw => new Raw(s);

const escapeText = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeText(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return new Raw(out);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/html.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/html.ts tests/unit/html.test.ts
git commit -m "feat: escaping html tagged template"
```

---

### Task 4: Locked-down PDF pipeline

**Files:**
- Create: `src/pdf/assets.ts`, `src/pdf/document.ts`, `src/pdf/browser.ts`, `src/pdf/render.ts`, `src/pdf/measure.ts`
- Test: `tests/render/pipeline.test.ts`

**Interfaces:**
- Consumes: `html`, `raw`, `Raw` from `src/lib/html.ts`.
- Produces:
  - `fontFaceCss(): string` (base64 `@font-face` rules for families `Playfair`, `Inter`, `Mono`)
  - `dataUri(filePath: string): string`
  - `documentShell(opts: { title: string; css: string; body: Raw }): string`
  - `launchBrowser(): Promise<Browser>`; `newLockedPage(browser: Browser): Promise<Page>`
  - `class PageOverflowError extends Error`
  - `assertNoOverflow(page: Page): Promise<void>`
  - `renderPdf(page: Page, docHtml: string): Promise<Buffer>`
  - `screenshotPages(page: Page, docHtml: string, outDir: string): Promise<string[]>`
  - `PX_PER_MM: number`; `measureFragments(page: Page, css: string, widthMm: number, fragments: Raw[]): Promise<number[]>`

- [ ] **Step 1: Write the failing tests**

`tests/render/pipeline.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { raw } from '../../src/lib/html';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { documentShell } from '../../src/pdf/document';
import { measureFragments } from '../../src/pdf/measure';
import { PageOverflowError, renderPdf } from '../../src/pdf/render';

const css = '.page{width:210mm;height:297mm;position:relative;overflow:hidden}.body{position:absolute;top:27mm;left:16mm;right:16mm;bottom:19mm}';
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchBrowser();
  page = await newLockedPage(browser);
});
afterAll(async () => {
  await browser.close();
});

describe('pdf pipeline', () => {
  it('produces a PDF', async () => {
    const doc = documentShell({ title: 't', css, body: raw('<section class="page"><div class="body">Hi</div></section>') });
    const pdf = await renderPdf(page, doc);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('does not run scripts in the document', async () => {
    const doc = documentShell({
      title: 't',
      css,
      body: raw('<section class="page"><div class="body"></div></section><script>document.body.dataset.ran="1"</script>'),
    });
    await page.setContent(doc);
    expect(await page.evaluate(() => document.body.dataset.ran)).toBeUndefined();
  });

  it('does not load remote images', async () => {
    const doc = documentShell({
      title: 't',
      css,
      body: raw('<img id="x" src="https://example.com/x.png"><section class="page"><div class="body"></div></section>'),
    });
    await page.setContent(doc);
    expect(await page.evaluate(() => (document.getElementById('x') as HTMLImageElement).naturalWidth)).toBe(0);
  });

  it('rejects a page whose content overflows', async () => {
    const doc = documentShell({
      title: 't',
      css,
      body: raw('<section class="page"><div class="body"><div style="height:400mm"></div></div></section>'),
    });
    await expect(renderPdf(page, doc)).rejects.toBeInstanceOf(PageOverflowError);
  });

  it('measures fragment heights', async () => {
    const [a, b] = await measureFragments(page, css, 178, [raw('<div style="height:100px"></div>'), raw('<div style="height:250px"></div>')]);
    expect(a).toBeCloseTo(100, 0);
    expect(b).toBeCloseTo(250, 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:render`
Expected: FAIL, cannot resolve `../../src/pdf/browser`.

- [ ] **Step 3: Implement the modules**

`src/pdf/assets.ts`:
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

export function dataUri(filePath: string): string {
  const mime = MIME[path.extname(filePath).toLowerCase()];
  if (!mime) throw new Error(`Unsupported asset type: ${filePath}`);
  return `data:${mime};base64,${readFileSync(filePath).toString('base64')}`;
}

const FONTS = [
  { family: 'Playfair', pkg: 'playfair-display', weights: [500, 600, 700] },
  { family: 'Inter', pkg: 'inter', weights: [400, 500, 600, 700] },
  { family: 'Mono', pkg: 'jetbrains-mono', weights: [400, 500] },
];

let cached: string | undefined;

export function fontFaceCss(): string {
  if (cached) return cached;
  const rules: string[] = [];
  for (const f of FONTS) {
    for (const w of f.weights) {
      const file = path.join(process.cwd(), 'node_modules', '@fontsource', f.pkg, 'files', `${f.pkg}-latin-${w}-normal.woff2`);
      rules.push(`@font-face{font-family:"${f.family}";src:url(${dataUri(file)}) format("woff2");font-weight:${w}}`);
    }
  }
  cached = rules.join('\n');
  return cached;
}
```

`src/pdf/document.ts`:
```ts
import { html, raw, type Raw } from '../lib/html';

const CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";

export function documentShell(opts: { title: string; css: string; body: Raw }): string {
  return html`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${opts.title}</title><style>${raw(opts.css)}</style></head><body>${opts.body}</body></html>`.value;
}
```

`src/pdf/browser.ts`:
```ts
import { chromium, type Browser, type Page } from 'playwright-core';

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? DEFAULT_CHROME });
}

/** A page that cannot reach the network. data: URLs are not intercepted, so embedded assets still load. */
export async function newLockedPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 794, height: 1123 },
    acceptDownloads: false,
  });
  await context.route('**/*', (route) => route.abort());
  return context.newPage();
}
```

`src/pdf/render.ts`:
```ts
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';

export class PageOverflowError extends Error {}

async function load(page: Page, docHtml: string): Promise<void> {
  await page.setContent(docHtml, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'print' });
}

export async function assertNoOverflow(page: Page): Promise<void> {
  const bad = await page.evaluate(() => {
    const out: number[] = [];
    document.querySelectorAll<HTMLElement>('.page').forEach((pg, i) => {
      const body = pg.querySelector<HTMLElement>('.body');
      const bodyOver = body ? body.scrollHeight > body.clientHeight + 1 : false;
      if (pg.scrollHeight > pg.clientHeight + 1 || bodyOver) out.push(i + 1);
    });
    return out;
  });
  if (bad.length > 0) throw new PageOverflowError(`Content overflows page ${bad.join(', ')}`);
}

export async function renderPdf(page: Page, docHtml: string): Promise<Buffer> {
  await load(page, docHtml);
  await assertNoOverflow(page);
  return page.pdf({ preferCSSPageSize: true, printBackground: true });
}

export async function screenshotPages(page: Page, docHtml: string, outDir: string): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  await load(page, docHtml);
  const pages = await page.$$('.page');
  const files: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const file = path.join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`);
    await pages[i].screenshot({ path: file });
    files.push(file);
  }
  return files;
}
```

`src/pdf/measure.ts`:
```ts
import type { Page } from 'playwright-core';
import { raw, type Raw } from '../lib/html';
import { documentShell } from './document';

export const PX_PER_MM = 96 / 25.4;

/** Height in CSS pixels of each fragment when laid out at the given width, margins included. */
export async function measureFragments(page: Page, css: string, widthMm: number, fragments: Raw[]): Promise<number[]> {
  const inner = fragments.map((f) => `<div data-m style="display:flow-root">${f.value}</div>`).join('');
  const doc = documentShell({ title: 'measure', css, body: raw(`<div style="width:${widthMm}mm">${inner}</div>`) });
  await page.setContent(doc, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'print' });
  return page.$$eval('[data-m]', (els) => els.map((e) => e.getBoundingClientRect().height));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:render`
Expected: PASS, 5 tests. If Chrome is not found, set `CHROMIUM_PATH` in `.env.local` or the shell and rerun.

- [ ] **Step 5: Commit**

```bash
git add src/pdf tests/render/pipeline.test.ts
git commit -m "feat: locked-down Chromium PDF pipeline with overflow guard"
```

---

### Task 5: Pure paginator

**Files:**
- Create: `src/pdf/paginate.ts`
- Test: `tests/unit/paginate.test.ts`

**Interfaces:**
- Produces:
  - `class PaginationError extends Error`
  - `interface Capacity { first: number; rest: number }`
  - `paginate(heights: number[], cap: Capacity): number[][]` (groups of item indexes, one group per page, always at least one group)

- [ ] **Step 1: Write the failing tests**

`tests/unit/paginate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PaginationError, paginate } from '../../src/pdf/paginate';

describe('paginate', () => {
  it('keeps everything on one page when it fits', () => {
    expect(paginate([100, 200, 300], { first: 700, rest: 900 })).toEqual([[0, 1, 2]]);
  });
  it('moves items to the next page when the first is full', () => {
    expect(paginate([400, 400, 400], { first: 900, rest: 900 })).toEqual([[0, 1], [2]]);
  });
  it('uses the larger "rest" capacity after the first page', () => {
    expect(paginate([500, 500, 500, 300], { first: 600, rest: 1000 })).toEqual([[0], [1, 2], [3]]);
  });
  it('returns one empty page for no items', () => {
    expect(paginate([], { first: 600, rest: 900 })).toEqual([[]]);
  });
  it('throws when one item is taller than a page', () => {
    expect(() => paginate([100, 1000], { first: 600, rest: 900 })).toThrow(PaginationError);
  });
  it('throws when the first item cannot fit the first page', () => {
    expect(() => paginate([700], { first: 600, rest: 900 })).toThrow(PaginationError);
  });
  it('throws on an invalid height', () => {
    expect(() => paginate([Number.NaN], { first: 600, rest: 900 })).toThrow(PaginationError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/paginate.test.ts`
Expected: FAIL, cannot resolve `../../src/pdf/paginate`.

- [ ] **Step 3: Implement**

`src/pdf/paginate.ts`:
```ts
export class PaginationError extends Error {}

export interface Capacity {
  first: number;
  rest: number;
}

/** Greedy fill. Items are never split; splitting a long section by bullets is a later plan. */
export function paginate(heights: number[], cap: Capacity): number[][] {
  const pages: number[][] = [[]];
  let used = 0;
  let limit = cap.first;
  heights.forEach((h, i) => {
    if (!(h >= 0)) throw new PaginationError(`Item ${i} has an invalid height: ${h}`);
    if (used + h > limit && pages[pages.length - 1].length > 0) {
      pages.push([]);
      used = 0;
      limit = cap.rest;
    }
    if (h > limit) {
      throw new PaginationError(`Item ${i} is ${Math.round(h)}px tall but a page holds ${Math.round(limit)}px`);
    }
    pages[pages.length - 1].push(i);
    used += h;
  });
  return pages;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/paginate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pdf/paginate.ts tests/unit/paginate.test.ts
git commit -m "feat: pure greedy paginator"
```

---

### Task 6: FJC theme and quotation template

**Files:**
- Create: `src/themes/types.ts`, `src/themes/theme.ts`, `src/themes/fjc/base.css`, `src/templates/parts.ts`, `src/templates/quotation.ts`
- Test: `tests/unit/theme.test.ts`, `tests/render/quotation.test.ts`, `tests/fixtures/fjc.ts`, `tests/fixtures/quotation.ts`

**Interfaces:**
- Consumes: `html`, `raw`, `Raw`; `computeTotals`, `formatGBP`, `MoneyLine`; `fontFaceCss`, `dataUri`; `documentShell`; `measureFragments`, `PX_PER_MM`; `paginate`; `renderPdf`.
- Produces:
  - `interface Tenant { name: string; addressLine: string; phone: string; email: string; web: string; companyNo: string; vatNo: string | null; tagline: string }`
  - `interface BrandAssets { logoColour: string; logoWhite: string; signature: string; coverPhoto: string; diagram: string }` (all data URIs)
  - `interface Brand { colours: Record<string, string>; assets: BrandAssets }`
  - `themeVarsCss(colours: Record<string, string>): string`; `loadBaseCss(): string`
  - `interface QuotationInput` (defined below) and `buildQuotation(page: Page, input: QuotationInput, tenant: Tenant, brand: Brand): Promise<string>` returning a complete HTML document string.

- [ ] **Step 1: Extract the reference and copy the stylesheet**

```bash
cd "/Users/alfie/Documents/TradesPro DocPortal"
mkdir -p reference src/themes/fjc tests/fixtures
unzip -q -o ~/Downloads/DocPortal_Reference.zip -d reference
sed '/^@font-face/d' reference/DocPortal_Reference/1_FJC_Roofing/templates_code/fjc.css > src/themes/fjc/base.css
grep -c "@font-face" src/themes/fjc/base.css
```
Expected: `0` (fonts come from `fontFaceCss()`).

- [ ] **Step 2: Write the failing theme test**

`tests/unit/theme.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadBaseCss, themeVarsCss } from '../../src/themes/theme';

describe('themeVarsCss', () => {
  it('emits CSS variables for each colour', () => {
    expect(themeVarsCss({ navy: '#0f2b4a', gold: '#C9A24B' })).toBe(':root{--navy:#0f2b4a;--gold:#C9A24B;}');
  });
  it('rejects values that are not 6-digit hex colours', () => {
    expect(() => themeVarsCss({ navy: 'red;}body{display:none' })).toThrow();
    expect(() => themeVarsCss({ navy: '#fff' })).toThrow();
  });
  it('rejects unsafe variable names', () => {
    expect(() => themeVarsCss({ 'na vy': '#0f2b4a' })).toThrow();
  });
});

describe('loadBaseCss', () => {
  it('loads the FJC stylesheet', () => {
    expect(loadBaseCss()).toContain('.scope-sec');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/unit/theme.test.ts`
Expected: FAIL, cannot resolve `../../src/themes/theme`.

- [ ] **Step 4: Implement the theme files**

`src/themes/types.ts`:
```ts
export interface Tenant {
  name: string;
  addressLine: string;
  phone: string;
  email: string;
  web: string;
  companyNo: string;
  vatNo: string | null;
  tagline: string;
}

export interface BrandAssets {
  logoColour: string;
  logoWhite: string;
  signature: string;
  coverPhoto: string;
  diagram: string;
}

export interface Brand {
  colours: Record<string, string>;
  assets: BrandAssets;
}
```

`src/themes/theme.ts`:
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HEX = /^#[0-9a-fA-F]{6}$/;
const NAME = /^[a-z][a-z0-9]*$/;

export function themeVarsCss(colours: Record<string, string>): string {
  const decls = Object.entries(colours).map(([name, value]) => {
    if (!NAME.test(name)) throw new Error(`Invalid theme variable name: ${name}`);
    if (!HEX.test(value)) throw new Error(`Invalid colour for ${name}: ${value}`);
    return `--${name}:${value};`;
  });
  return `:root{${decls.join('')}}`;
}

export function loadBaseCss(): string {
  return readFileSync(path.join(process.cwd(), 'src', 'themes', 'fjc', 'base.css'), 'utf8');
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/unit/theme.test.ts`
Expected: PASS.

- [ ] **Step 6: Write fixtures**

`tests/fixtures/fjc.ts`:
```ts
import { existsSync } from 'node:fs';
import path from 'node:path';
import { dataUri } from '../../src/pdf/assets';
import type { Brand, Tenant } from '../../src/themes/types';

export const REFERENCE_ASSETS = path.join(
  process.cwd(),
  'reference',
  'DocPortal_Reference',
  '1_FJC_Roofing',
  'brand_assets',
);

export const referenceAvailable = existsSync(REFERENCE_ASSETS);

export const fjcTenant: Tenant = {
  name: 'FJC Roofing Ltd',
  addressLine: 'Rochester · United Kingdom · ME3 9UD',
  phone: '07596115834',
  email: 'Ben@fjcroofingltd.com',
  web: 'www.fjcroofingltd.co.uk',
  companyNo: '13855379',
  vatNo: 'GB 408094403',
  tagline: 'Covering Your Home, Protecting Your Family',
};

export const fjcColours = {
  navy: '#0f2b4a',
  navy2: '#16395f',
  navy3: '#1f4a78',
  blue: '#2f6fbf',
  sky: '#7fa6dc',
  ice: '#e9f0f9',
  gold: '#c9a24b',
  gold2: '#e4cf9a',
  goldbg: '#faf5e8',
  ink: '#152235',
  body: '#3a4657',
  muted: '#6b7686',
  rule: '#dde3eb',
  paper: '#f4f6fa',
};

export function loadFjcBrand(): Brand {
  const f = (name: string) => dataUri(path.join(REFERENCE_ASSETS, name));
  return {
    colours: fjcColours,
    assets: {
      logoColour: f('logo.png'),
      logoWhite: f('logo_white.png'),
      signature: f('sig_rgba.png'),
      coverPhoto: f('ph_flat.jpg'),
      diagram: f('diag_flat.jpg'),
    },
  };
}
```

`tests/fixtures/quotation.ts` (the interface lives in `src/templates/quotation.ts`, created in Step 8):
```ts
import type { QuotationInput } from '../../src/templates/quotation';

export const quotationFixture: QuotationInput = {
  ref: 'QT-JS-001',
  dateLabel: '21 September 2026',
  validityDays: 30,
  customer: { name: 'Mr John Smith', email: 'john.smith@example.com', phone: '07700 900123' },
  property: '123 Bromley Road, BR2 8BG',
  preparedBy: 'Ben Cunningham, FJC Roofing Ltd',
  coverEyebrow: 'Residential · Flat Roof Installation Quotation',
  coverTitle: 'Flat Roof Installation Quotation',
  coverSub: 'Complete flat roof installation, full scope of works and pricing',
  introText:
    'FJC Roofing Ltd is pleased to present this quotation for a complete flat roof installation at 123 Bromley Road, BR2 8BG. This document sets out the full scope of works, materials, and pricing for the project.',
  specHeading: 'The system we are installing',
  specCards: [
    { big: '3-Layer Felt', label: 'Roofing system' },
    { big: 'Code 4 Lead', label: 'Perimeter flashing' },
    { big: '20 Years', label: 'Guarantee', accent: true },
  ],
  diagram: {
    eyebrow: 'Beneath the finish',
    heading: 'Every layer has a job to do',
    body: 'A 2mm perforated tack-down layer, a 3mm fully bonded underlay and a 5mm mineral cap sheet work together as one system, finished with Code 4 lead flashing to the perimeter wall.',
    caption: 'Example felt flat roofing build-up. The exact system can vary depending on the roof and specification required.',
  },
  callout: null,
  scopeHeading: 'What we will do, step by step',
  scope: [
    {
      heading: 'Site set-up',
      bullets: [
        'All waste materials will be taken via our flatbed truck to a skip at our yard, keeping the site clear and tidy throughout the works.',
        'Protection will be laid to the floors and walls within the property where needed, covering the rooms our team will need to pass through to gain access to the roof.',
      ],
    },
    {
      heading: 'Strip-out & removal',
      bullets: [
        'The existing decking area will be removed in full, along with its structural base.',
        'The original roof covering will be removed, exposing the insulation beneath.',
        'A full inspection of the insulation will be carried out to guarantee there is no dampness before the new roof is installed.',
        'All edging covering the flashing detail will be removed, ready for the new edge flashings to be installed.',
      ],
    },
    {
      heading: 'Decking & drainage',
      bullets: [
        '9mm OSB ply boards will be installed across the roof, providing a solid, stable deck for the new felt roof system.',
        'An internal outlet will be installed to the flat roof, allowing for more drainage so that water clears from the roof surface freely.',
      ],
    },
    {
      heading: 'Waterproofing',
      bullets: [
        'A 2mm perforated tack-down layer of felt will be installed as the first layer of the system, allowing the roof to vent and helping to prevent blistering of the layers above.',
        'A 3mm fully bonded underlay will be installed with all edging flashings, providing a fully sealed base layer across the whole roof.',
        'A 5mm mineral cap sheet will be installed with all edging flashings, giving the roof a durable, weather-resistant finish.',
      ],
    },
    {
      heading: 'Lead flashing',
      bullets: [
        'Code 4, 6-inch lead flashing will be installed to the perimeter wall, encapsulating all felt flashings and ensuring a fully weathertight junction between the roof and the wall.',
      ],
    },
  ],
  guarantee: {
    years: 20,
    text: 'The roofing system specified above has been selected specifically for this project, and allows FJC Roofing Ltd to provide a 20-year guarantee on completion of the works.',
  },
  vatRateBp: 2000,
  lines: [
    {
      description: 'Flat roof installation, 123 Bromley Road, complete works as specified above',
      kind: 'Work',
      qty: 1,
      unitNetPence: 735500,
      vatApplies: true,
    },
    {
      description: 'Protection fee, protection of floors and walls in the property where needed',
      kind: 'Fee',
      qty: 1,
      unitNetPence: 15000,
      vatApplies: true,
    },
  ],
  terms:
    'This quotation is valid for 30 days from the date above. All materials supplied and installed as part of this contract remain the property of FJC Roofing Ltd until paid for in full.',
  disclaimer:
    'This quotation is generated using third-party software. The platform is not a party to any contract formed between the customer and the trader for the services listed within this document. The platform has not benchmarked, endorsed, or verified the services or prices stated. For information on how personal data is processed, please refer to the relevant Privacy Notice.',
};
```

- [ ] **Step 7: Write the failing render test**

`tests/render/quotation.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { renderPdf } from '../../src/pdf/render';
import { buildQuotation } from '../../src/templates/quotation';
import { fjcTenant, loadFjcBrand, referenceAvailable } from '../fixtures/fjc';
import { quotationFixture } from '../fixtures/quotation';

describe.skipIf(!referenceAvailable)('quotation', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newLockedPage(browser);
  });
  afterAll(async () => {
    await browser.close();
  });

  it('renders four pages with the correct totals', async () => {
    const doc = await buildQuotation(page, quotationFixture, fjcTenant, loadFjcBrand());
    const pdf = await renderPdf(page, doc);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(await page.$$eval('.page', (p) => p.length)).toBe(4);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toContain('£7,505.00');
    expect(text).toContain('£1,501.00');
    expect(text).toContain('£9,006.00');
  });

  it('escapes customer-supplied text', async () => {
    const input = { ...quotationFixture, customer: { ...quotationFixture.customer, name: '<img src=x onerror=alert(1)>' } };
    const doc = await buildQuotation(page, input, fjcTenant, loadFjcBrand());
    await renderPdf(page, doc);
    expect(await page.$$eval('img[onerror]', (e) => e.length)).toBe(0);
    expect(await page.evaluate(() => document.body.innerText)).toContain('<img src=x onerror=alert(1)>');
  });

  it('flows a long scope onto extra pages and numbers the footers consistently', async () => {
    const extra = quotationFixture.scope.map((s) => ({ ...s, heading: `${s.heading} (additional)` }));
    const input = { ...quotationFixture, scope: [...quotationFixture.scope, ...extra, ...extra] };
    const doc = await buildQuotation(page, input, fjcTenant, loadFjcBrand());
    await renderPdf(page, doc);
    const count = await page.$$eval('.page', (p) => p.length);
    expect(count).toBeGreaterThan(4);
    const totals = await page.$$eval('.rf .pg', (els) => els.map((e) => e.textContent ?? ''));
    expect(totals).toHaveLength(count);
    totals.forEach((t, i) => {
      expect(t).toContain(`${String(i + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}`);
    });
  });
});
```

- [ ] **Step 8: Run to verify it fails**

Run: `npm run test:render -- tests/render/quotation.test.ts`
Expected: FAIL, cannot resolve `../../src/templates/quotation`.

- [ ] **Step 9: Implement the shared parts**

`src/templates/parts.ts`:
```ts
import { html, type Raw } from '../lib/html';
import { formatGBP } from '../lib/money';
import type { Brand, Tenant } from '../themes/types';

export const pad2 = (n: number): string => String(n).padStart(2, '0');

export function runningHeader(t: Tenant, b: Brand, label: string, ref: string): Raw {
  return html`<div class="rh"><img src="${b.assets.logoColour}" alt="${t.name}"><div class="meta"><span class="eyebrow">${label}</span><div class="ref">${ref}</div></div></div>`;
}

export function runningFooter(t: Tenant, n: number, total: number): Raw {
  return html`<div class="rf"><span class="tag">${t.tagline}</span><span>${t.name} · Company No. ${t.companyNo}</span><span class="pg">Page ${pad2(n)} / ${pad2(total)}</span></div>`;
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
  return html`<div class="toc">${entries.map(([label, pg], i) => html`<div><div class="n">${pad2(i + 1)}</div><div class="l">${label}</div><div class="p">Page ${pad2(pg)}</div></div>`)}</div>`;
}

export function coverHero(
  t: Tenant,
  b: Brand,
  c: { eyebrow: string; title: string; sub: string; strip: [string, string][] },
): Raw {
  return html`<div class="cover-hero"><div class="ph" style="background-image:url(${b.assets.coverPhoto})"></div><div class="shade"></div><div class="in"><img class="logo" src="${b.assets.logoWhite}" alt="${t.name}"><div class="contact">${t.addressLine}<br>${t.phone} · ${t.email}<br>Company No. ${t.companyNo}</div><div class="spacer"></div><span class="eyebrow w">${c.eyebrow}</span><h1>${c.title}</h1><div class="rule"></div><div class="sub">${c.sub}</div><div class="strip">${c.strip.map(([a, v]) => html`<div>${a}<b>${v}</b></div>`)}</div></div></div>`;
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

export function totalsBlock(rows: [string, string][], grandLabel: string, grand: string): Raw {
  return html`<div class="totals">${rows.map(([a, b]) => html`<div class="row"><span>${a}</span><span>${b}</span></div>`)}<div class="grand"><span>${grandLabel}</span><span>${grand}</span></div></div>`;
}

export function signBlock(b: Brand, name: string, role: string, nameLine: string, date: string): Raw {
  return html`<div class="sign"><div class="s"><img src="${b.assets.signature}" alt="Signature of ${name}"><div class="line"><div class="nm">${name}</div><div class="rl">${role}</div></div></div><div class="small" style="padding-bottom:1mm">${nameLine}<br>${date}</div></div>`;
}

export const money = formatGBP;
```

- [ ] **Step 10: Implement the quotation builder**

`src/templates/quotation.ts`:
```ts
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
  preparedBy: string;
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

const LABEL = 'Quotation';
const BODY_MM = 297 - 27 - 19; // .body: top 27mm, bottom 19mm in base.css
const BODY_WIDTH_MM = 210 - 2 * 16;
const SAFETY_PX = 12;

export async function buildQuotation(page: Page, input: QuotationInput, tenant: Tenant, brand: Brand): Promise<string> {
  const css = [fontFaceCss(), loadBaseCss(), themeVarsCss(brand.colours)].join('\n');
  const totals = computeTotals(input.lines, input.vatRateBp);

  // 1. Measure the scope so it can be split across pages without clipping.
  const sectionFrags = input.scope.map((s, i) => P.scopeSection(i + 1, s));
  const band = input.guarantee ? P.guaranteeBand(input.guarantee.years, input.guarantee.text) : null;
  const items: Raw[] = band ? [...sectionFrags, band] : sectionFrags;
  const headFirst = html`<span class="eyebrow">Scope of works</span><h2>${input.scopeHeading}</h2><div class="rule"></div>`;
  const headRest = html`<span class="eyebrow">Scope of works, continued</span><div style="height:3mm"></div>`;
  const [hFirst, hRest, ...heights] = await measureFragments(page, css, BODY_WIDTH_MM, [headFirst, headRest, ...items]);
  const bodyPx = BODY_MM * PX_PER_MM;
  const groups = paginate(heights, { first: bodyPx - hFirst - SAFETY_PX, rest: bodyPx - hRest - SAFETY_PX });

  const total = 2 + groups.length + 1;
  const firstScopePage = 3;
  const guaranteePage = band ? firstScopePage + groups.findIndex((g) => g.includes(items.length - 1)) : null;
  const header = P.runningHeader(tenant, brand, LABEL, input.ref);
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
      ['Total inc. VAT', formatGBP(totals.grossPence)],
    ],
  })}<div style="padding:9mm 16mm 0"><div class="details">${P.kv('Client', input.customer.name)}${P.kv('Quote date', input.dateLabel)}${P.kv('Property', input.property)}${P.kv('Quote reference', input.ref)}${P.kv('Contact email', input.customer.email)}${P.kv('Prepared by', input.preparedBy)}${P.kv('Contact number', input.customer.phone)}${P.kv('Validity', `Valid for ${input.validityDays} days from the date above`)}</div><div style="margin-top:7mm;display:grid;grid-template-columns:44mm 1fr;gap:8mm"><div><span class="eyebrow">Introduction</span><h3 style="margin-top:1.5mm">Your quotation</h3><div class="rule"></div></div><p class="lede">${input.introText}</p></div></div>${P.toc(tocEntries)}${footer(1)}</section>`;

  // 3. Specification.
  const d = input.diagram;
  const cols = input.specCards.length <= 3 ? 'c3' : 'c4';
  const spec = P.page(
    html`<span class="eyebrow">Roof specification</span><h2>${input.specHeading}</h2><div class="rule"></div><div class="cards ${cols}">${input.specCards.map((c) => html`<div class="card${c.accent ? ' gold' : ''}"><div class="big">${c.big}</div><div class="lab">${c.label}</div></div>`)}</div><div style="display:grid;grid-template-columns:1.25fr 1fr;gap:8mm;margin-top:9mm;align-items:center"><div style="background:#f4f6fa;padding:2mm"><img src="${brand.assets.diagram}" alt="${d.heading}" style="width:100%;display:block"></div><div><span class="eyebrow">${d.eyebrow}</span><h3 style="margin-top:1.5mm">${d.heading}</h3><div class="rule"></div><p>${d.body}</p><p class="small">${d.caption}</p></div></div>${input.callout ? html`<div class="callout" style="margin-top:10mm"><span class="eyebrow">${input.callout.label}</span>${input.callout.text}</div>` : null}`,
    header,
    footer(2),
  );

  // 4. Scope pages.
  const scopePages = groups.map((g, gi) => {
    const lead = gi === 0 ? headFirst : headRest;
    return P.page(html`${lead}<div>${g.map((idx) => items[idx])}</div>`, header, footer(firstScopePage + gi));
  });

  // 5. Pricing.
  const showVat = input.lines.some((l) => l.vatApplies);
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
    html`<span class="eyebrow">Pricing</span><h2>Your quotation</h2><div class="rule"></div>${P.priceTable(rows, showVat)}${P.totalsBlock(totalRows, 'Total', formatGBP(totals.grossPence))}<div class="terms" style="margin-top:10mm"><div class="t"><h5>Terms and conditions</h5><p>${input.terms}</p></div>${showVat && tenant.vatNo ? html`<div class="t"><h5>VAT registration number</h5><p class="mono">${tenant.vatNo}</p></div>` : null}</div><div style="margin-top:12mm"><span class="eyebrow">Prepared by</span><div style="margin-top:4mm">${P.signBlock(brand, input.preparedBy.split(',')[0], `Director · ${tenant.name}`, input.preparedBy, input.dateLabel)}</div></div><div class="fine" style="position:absolute;bottom:0;left:0;right:0"><b>Important information</b>${input.disclaimer}</div>`,
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
```

- [ ] **Step 11: Run all tests**

Run: `npm test && npm run test:render && npm run typecheck`
Expected: unit tests PASS; render tests PASS (quotation tests are skipped only if `reference/` is missing); typecheck clean. If `PageOverflowError` is thrown for the 4-page fixture, reduce `SAFETY_PX` only if the pages are genuinely not overflowing; otherwise inspect with the Task 7 screenshots before changing anything.

- [ ] **Step 12: Commit**

```bash
git add src tests
git commit -m "feat: FJC theme and paginated quotation template"
```

---

### Task 7: Render spike and visual review

**Files:**
- Create: `scripts/render-spike.ts`

**Interfaces:**
- Consumes: `launchBrowser`, `newLockedPage`, `renderPdf`, `screenshotPages`, `buildQuotation`, fixtures.

- [ ] **Step 1: Write the script**

`scripts/render-spike.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchBrowser, newLockedPage } from '../src/pdf/browser';
import { renderPdf, screenshotPages } from '../src/pdf/render';
import { buildQuotation } from '../src/templates/quotation';
import { fjcTenant, loadFjcBrand } from '../tests/fixtures/fjc';
import { quotationFixture } from '../tests/fixtures/quotation';

async function main() {
  mkdirSync('out/quotation', { recursive: true });
  const browser = await launchBrowser();
  try {
    const page = await newLockedPage(browser);
    const doc = await buildQuotation(page, quotationFixture, fjcTenant, loadFjcBrand());
    writeFileSync('out/quotation/quotation.pdf', await renderPdf(page, doc));
    const files = await screenshotPages(page, doc, 'out/quotation');
    console.log('PDF: out/quotation/quotation.pdf');
    console.log(files.join('\n'));
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
Expected: prints the PDF path and four `out/quotation/page-0N.png` paths.

- [ ] **Step 3: Review every page by eye**

Open each `out/quotation/page-0N.png` and compare it with the matching page of `reference/DocPortal_Reference/1_FJC_Roofing/sample_documents/FJC_01_Quotation_-_Flat_Roof_Installation.pdf`. Check: header and footer bands, cover photo fade, contents row, spec cards, diagram panel, numbered scope with gold guarantee band, pricing table and totals, signature, disclaimer, fonts (Playfair headings, Inter body, JetBrains Mono labels, no fallback serif), no clipped text, no overlap between the contents row and the intro. Write down every visible difference. Fix real layout bugs in `src/themes/fjc/base.css` or `src/templates/*`, rerun `npm run spike`, and repeat until the output matches the reference layout. The customer, property and price text will differ, which is expected.

- [ ] **Step 4: Run the full suite and commit**

```bash
npm test && npm run test:render && npm run typecheck && npm run build
git add scripts src tests
git commit -m "feat: render spike script and layout fixes from visual review"
```

---

## Out of scope for this plan (later plans)

- Plan 2: Supabase schema, RLS, auth, TOTP, lockout, tenant isolation tests.
- Plan 3: remaining five templates, bullet-level splitting of very long sections, and the `renderPdf` Vercel/Chromium adapter.
- Plan 4: AI scope writing with zod validation.
- Plan 5: owner UI (form, preview, inline edit, finalise, download, email).
- Plan 6: seed data, 30 day purge job, README and the "add a new client" guide.
