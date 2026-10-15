import type { RenderPage as Page } from '../pdf/engine';
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
