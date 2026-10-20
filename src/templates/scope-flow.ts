import type { RenderPage as Page } from '../pdf/engine';
import { html, type Raw } from '../lib/html';
import { measureFragments, PX_PER_MM } from '../pdf/measure';
import { paginate, PaginationError } from '../pdf/paginate';

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
  /** Measure the sections at the compact size. The caller wraps the sections it places in `.scope-compact` itself. */
  compact?: boolean;
  /**
   * The sections as data, so one too tall for a page can be split between its bullets (it is then shown as two or more
   * parts under the same number, each later part headed "<heading> (continued)"). `sections` must be build(i + 1, s) of
   * these. Without it a section taller than a page is an error.
   */
  split?: { scope: ScopeSection[]; build: (n: number, s: ScopeSection) => Raw };
}

export interface ScopeSection {
  heading: string;
  bullets: string[];
}

export interface ScopeFlow {
  items: Raw[];
  groups: number[][];
}

export async function flowScope(o: ScopeFlowOptions): Promise<ScopeFlow> {
  const items = [...o.sections, ...(o.trailing ?? [])];
  // Each fragment is measured alone (so each is :first-of-type and has no top border); the border is added back below.
  const toMeasure = o.compact ? [...o.sections.map(wrapCompact), ...(o.trailing ?? [])] : items;
  const [hFirst, hRest, ...measured] = await measureFragments(o.page, o.css, o.widthMm, [o.headFirst, o.headRest, ...toMeasure]);
  const heights = measured.map((h, i) => (i < o.sections.length ? h + SECTION_BORDER_PX : h));
  const cap = {
    first: o.firstAreaMm * PX_PER_MM - hFirst - SAFETY_PX,
    rest: o.restAreaMm * PX_PER_MM - hRest - SAFETY_PX,
  };
  const tooTall = heights.slice(0, o.sections.length).some((h) => h > cap.rest);
  if (!o.split || !tooTall) return { items, groups: paginate(heights, cap) };
  return flowSplitting(o, o.split, heights, cap);
}

function wrapCompact(r: Raw): Raw {
  return html`<div class="scope-compact">${r}</div>`;
}

/** Bullets kept with a heading when a too-tall section starts in the space left on a page. */
const MIN_BULLETS_TO_START = 2;

/**
 * Greedy fill as paginate does, but a section taller than a whole page is split between its bullets: it starts in the
 * space left on the current page (when at least two of its bullets fit there with the heading), and carries on to the
 * next pages under the same number, headed "<heading> (continued)". Sections that fit a page are never split, as on the
 * owner's quotations. A heading is never left without a bullet under it.
 */
async function flowSplitting(o: ScopeFlowOptions, split: NonNullable<ScopeFlowOptions['split']>, heights: number[], cap: { first: number; rest: number }): Promise<ScopeFlow> {
  const wrap = (r: Raw) => (o.compact ? wrapCompact(r) : r);
  const items: Raw[] = [];
  const pages: number[][] = [[]];
  let used = 0;
  let limit = cap.first;
  const newPage = () => {
    pages.push([]);
    used = 0;
    limit = cap.rest;
  };
  const place = (r: Raw, h: number) => {
    items.push(r);
    pages[pages.length - 1].push(items.length - 1);
    used += h;
  };
  for (let i = 0; i < o.sections.length; i++) {
    const h = heights[i];
    if (h <= cap.rest) {
      if (used + h > limit && pages[pages.length - 1].length > 0) newPage();
      place(o.sections[i], h);
      continue;
    }
    const s = split.scope[i];
    let rest = s.bullets;
    let part = 0;
    while (rest.length > 0) {
      const heading = part === 0 ? s.heading : `${s.heading} (continued)`;
      const tries = rest.map((_, k) => split.build(i + 1, { heading, bullets: rest.slice(0, k + 1) }));
      const hs = (await measureFragments(o.page, o.css, o.widthMm, tries.map(wrap))).map((x) => x + SECTION_BORDER_PX);
      const room = limit - used;
      let k = hs.findIndex((x) => x > room);
      if (k === -1) k = rest.length;
      const wanted = Math.min(MIN_BULLETS_TO_START, rest.length);
      if (k < wanted && pages[pages.length - 1].length > 0) {
        newPage();
        continue;
      }
      if (k === 0) throw new PaginationError(`A bullet in section ${i + 1} is taller than a page`);
      place(tries[k - 1], hs[k - 1]);
      rest = rest.slice(k);
      part += 1;
      if (rest.length > 0) newPage();
    }
  }
  const trailing = o.trailing ?? [];
  trailing.forEach((t, j) => {
    const h = heights[o.sections.length + j];
    if (used + h > limit && pages[pages.length - 1].length > 0) newPage();
    if (h > limit) throw new PaginationError(`A trailing item is ${Math.round(h)}px tall but a page holds ${Math.round(limit)}px`);
    place(t, h);
  });
  return { items, groups: pages.filter((p) => p.length > 0) };
}
