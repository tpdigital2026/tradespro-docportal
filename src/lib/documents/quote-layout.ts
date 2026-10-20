/**
 * Which locked template a quotation (and the documents that follow it) uses, from the kind of job, and the small rules
 * the owner's quotations follow around the data (reference sample_documents FJC_01 to FJC_07). Pure.
 *
 * The pictures themselves are never chosen here: each template owns its images (src/templates/registry.ts).
 */
import type { QuotationInput } from '../../templates/quotation';
import type { TemplateVariant } from '../../templates/registry';

export type QuoteKind = 'tiled' | 'flat' | 'mixed' | 'fascia' | 'other';

export interface QuoteShape {
  /** The roof the work is on. */
  kind: QuoteKind;
  /** A commercial job (the cover title starts "Commercial"): Commercial in the eyebrow and the client in the cover strip. */
  commercial: boolean;
}

const KIND_OF_JOB_TYPE: Record<string, QuoteKind> = { tiled_roof: 'tiled', flat_roof: 'flat', fascia: 'fascia', other: 'other' };
const TILED_WORDS = /\b(tiled?|tiles|pitched|inclined)\b/i;
const FLAT_WORDS = /\bflat\b/i;

/**
 * From the job type's key and the cover's title and sub-title. A tiled, flat or other roof job whose cover names both a
 * tiled (or pitched) roof and a flat roof is a mixed job, as on the owner's tiled-and-flat quotation.
 */
export function quoteShape(jobTypeKey: string, coverTitle: string, coverSub: string): QuoteShape {
  const base = KIND_OF_JOB_TYPE[jobTypeKey] ?? 'other';
  const words = `${coverTitle} ${coverSub}`;
  const kind: QuoteKind = base !== 'fascia' && TILED_WORDS.test(words) && FLAT_WORDS.test(words) ? 'mixed' : base;
  return { kind, commercial: /^\s*commercial\b/i.test(coverTitle) };
}

/**
 * The template family for a kind of job: flat roof, tiled roof, tiled and flat, or (a commercial tiled roof, as FJC_07)
 * commercial roofing. Fascias, guttering and other jobs have none yet (parked by the owner): they keep the plain layout.
 */
export function templateVariant(s: QuoteShape): TemplateVariant | null {
  if (s.kind === 'flat') return 'flat-roof';
  if (s.kind === 'mixed') return 'tiled-and-flat-roof';
  if (s.kind === 'tiled') return s.commercial ? 'commercial-roofing' : 'tiled-roof';
  return null;
}

/** "Residential · Re-Roof Quotation"; "Commercial Re-Roof Quotation" gives "Commercial · Re-Roof Quotation". */
export function coverEyebrow(coverTitle: string, s: QuoteShape, sector: { residential: string; commercial: string }): string {
  if (!s.commercial) return `${sector.residential} · ${coverTitle}`;
  const rest = coverTitle.replace(/^\s*commercial\s*/i, '').trim();
  return rest ? `${sector.commercial} · ${rest}` : coverTitle;
}

/**
 * The key figures with the guarantee as the last, gold, card when the job has one (as every guaranteed quotation of
 * the owner's does). A figure the owner already gave for the guarantee is turned gold instead of repeated.
 */
export function specCardsWithGuarantee(cards: QuotationInput['specCards'], guaranteeYears: number | null): QuotationInput['specCards'] {
  if (!guaranteeYears) return cards.map((c) => ({ ...c, accent: false }));
  const own = cards.findIndex((c) => /guarantee/i.test(c.label));
  if (own >= 0) return cards.map((c, i) => ({ ...c, accent: i === own }));
  return [...cards.map((c) => ({ ...c, accent: false })), { big: `${guaranteeYears} Years`, label: 'Guarantee', accent: true }];
}

/** The template's guarantee band wording with {years} and {business} filled in. */
export function guaranteeBandText(years: number, business: string, band: string): string {
  return band.replaceAll('{years}', String(years)).replaceAll('{business}', business);
}
