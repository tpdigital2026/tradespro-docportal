// Pure, browser-safe brand helpers (no database, no filesystem), so client components can import them.
import type { CSSProperties } from 'react';
import { isValidSlug } from './slug';

export interface Logo {
  url: string;
  width: number;
  height: number;
}

/** The public face of one business. Everything here is safe to show before anyone has signed in. */
export interface TenantBrand {
  name: string;
  /** Short sign-in address, or null for TradesPro Digital's own brand. */
  slug: string | null;
  /** Colour logo for white surfaces. TradesPro has none (its wordmark is white), so this is null there. */
  logoLight: Logo | null;
  /** White logo for the navy rail and header. */
  logoDark: Logo;
  /** A validated #rrggbb, or null when the business has none or it is unusable. */
  accent: string | null;
  isOwnBrand: boolean;
}

export const TRADESPRO_BRAND: TenantBrand = {
  name: 'TradesPro Digital',
  slug: null,
  logoLight: null,
  logoDark: { url: '/tradespro-logo.png', width: 704, height: 355 },
  accent: null,
  isOwnBrand: true,
};

/** Demo mode shows the real FJC logo files with dummy customers and documents. */
export const DEMO_BRAND: TenantBrand = {
  name: 'FJC Roofing Ltd',
  slug: 'fjc',
  logoLight: { url: '/brands/fjc/logo.png', width: 1036, height: 439 },
  logoDark: { url: '/brands/fjc/logo_white.png', width: 1036, height: 439 },
  accent: '#2f6fbf',
  isOwnBrand: false,
};

export { RESERVED_SLUGS, isValidSlug } from './slug';

/* ---------- colour ---------- */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const WHITE = '#ffffff';
const NAVY = '#071626';

export function parseHex(h: unknown): [number, number, number] | null {
  if (typeof h !== 'string' || !HEX_RE.test(h)) return null;
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(h: string): number {
  const rgb = parseHex(h)!.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface AccentPlan {
  /** Fills: buttons, the active marker, the current stage tick. */
  fill: string;
  /** Text, links and focus rings on white. Only the business colour when it passes AA on white. */
  ink: string | null;
  /** Text on a fill: white or navy, whichever reads better. */
  onFill: string;
}

/**
 * Turns a business colour into what may be used where.
 * - strict #rrggbb only;
 * - below 3:1 against white it is too faint to be a fill either, so the TradesPro blue stays;
 * - at 4.5:1 or more it may also be used for text and focus rings, otherwise ink stays the TradesPro tone.
 */
export function planAccent(hex: unknown): AccentPlan | null {
  if (!parseHex(hex)) return null;
  const h = (hex as string).toLowerCase();
  const onWhite = contrastRatio(h, WHITE);
  if (onWhite < 3) return null;
  const onFill = contrastRatio(WHITE, h) >= contrastRatio(NAVY, h) ? WHITE : NAVY;
  return { fill: h, ink: onWhite >= 4.5 ? h : null, onFill };
}

/**
 * CSS variable overrides for the layout root. Only validated hex values ever reach a style
 * attribute, and only three variables are ever set, so no tenant text becomes CSS.
 */
export function brandStyle(brand: TenantBrand): CSSProperties | undefined {
  const plan = planAccent(brand.accent);
  if (!plan) return undefined;
  const vars: Record<string, string> = { '--accent': plan.fill, '--on-accent': plan.onFill };
  if (plan.ink) vars['--accent-ink'] = plan.ink;
  return vars as CSSProperties;
}

