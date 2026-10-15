import { stripInvisible, hasInvisible } from '../lib/scope/invisible';
import { BRANDS } from './brands';
import { CLAIM_WORDS } from './vocab/claims';
import { NUMBER_WORDS } from './vocab/numbers';
import { PRODUCT_WORDS } from './vocab/products';
import { pluralStem, stemCandidates } from './vocab/stems';
import { UNIT_WORDS } from './vocab/units';

/**
 * The guard against invention. Whatever the engine, the wording that comes back may not contain a figure, a
 * material or product, a unit, a claim, a brand or a name that is not in what the owner wrote. This does not prove
 * the wording is faithful (nothing can); it stops the failures that matter on a quotation: invented numbers,
 * products, standards and promises.
 *
 * Matching rules, deliberately blunt: text is NFKC-normalised first; words are split on anything that is not a letter
 * (so ten-year and fully-guaranteed are four words); restricted vocabularies match on the EXACT word (plural
 * stripped) with no fuzziness, so rafter is not after and slate is not slats; mixed-script and non-Latin words are
 * rejected unless the owner typed them.
 */

export type InventionKind = 'number' | 'product' | 'unit' | 'claim' | 'name' | 'script' | 'hidden';
export interface Invention {
  kind: InventionKind;
  word: string;
}

const PRODUCTS = new Set(PRODUCT_WORDS);
const UNITS = new Set(UNIT_WORDS);
const CLAIMS = new Set(CLAIM_WORDS);

const BRAND_SET = new Set(BRANDS);

const DIGITS = /\p{Nd}+(?:[.,]\p{Nd}+)*|[¼½¾]/gu;
const WORD = /[\p{L}\p{M}]+/gu;
const NON_LATIN = /[^\p{Script=Latin}\p{M}]/u;

const stem = pluralStem;

const norm = (t: string) => stripInvisible(stripInvisible(t).normalize('NFKC'));

function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DIGITS)) out.push(m[0] === '½' ? '0.5' : m[0] === '¼' ? '0.25' : m[0] === '¾' ? '0.75' : m[0].replace(/,/g, ''));
  for (const m of text.toLocaleLowerCase('en-GB').matchAll(WORD)) {
    const n = NUMBER_WORDS[m[0]];
    if (n) out.push(n);
  }
  return out;
}

const strip = (t: string) => t.replace(/\bsteps?\s+\p{Nd}+\b/giu, ' ');

/**
 * Is this word on one of the restricted lists? First as written (plural stripped), then by the exact bases that a
 * suffix rule leaves behind. The owner's own words unlock only the exact word or its plural (never a derived form):
 * if the owner wrote "slated" in some other sense, "slate" is still flagged. That costs a few false alarms (the owner
 * wrote "insulation", the AI says "insulate") and the result is the basic tidy, which is the safe direction.
 */
function restricted(w: string): InventionKind | null {
  const s = stem(w);
  if (PRODUCTS.has(s)) return 'product';
  if (UNITS.has(s)) return 'unit';
  if (CLAIMS.has(s)) return 'claim';
  for (const c of stemCandidates(w)) {
    if (PRODUCTS.has(c)) return 'product';
    if (UNITS.has(c)) return 'unit';
    if (CLAIMS.has(c)) return 'claim';
  }
  return null;
}

export function findInventions(inputTexts: readonly string[], outputTexts: readonly string[]): Invention[] {
  const input = inputTexts.map(norm).join('\n');
  const inputNumbers = new Set(numbersIn(input));
  const inputWords = new Set([...input.matchAll(WORD)].map((m) => m[0].toLocaleLowerCase('en-GB')));
  const inputStems = new Set([...inputWords].map(stem));
  const inputSymbols = new Set(input.match(/[£$€%]/g) ?? []);
  const found: Invention[] = [];
  const seen = new Set<string>();
  const add = (kind: InventionKind, word: string) => {
    const k = `${kind}:${word.toLocaleLowerCase('en-GB')}`;
    if (!seen.has(k)) {
      seen.add(k);
      found.push({ kind, word });
    }
  };

  for (const raw of outputTexts) {
    // Invisible characters in the wording are refused outright: they only ever serve to split a word.
    if (hasInvisible(raw)) add('hidden', 'hidden character');
    const text = strip(norm(raw));
    for (const n of numbersIn(text)) if (!inputNumbers.has(n)) add('number', n);
    for (const sym of text.match(/[£$€%]/g) ?? []) if (!inputSymbols.has(sym)) add('number', sym);
    for (const m of text.matchAll(WORD)) {
      const w = m[0];
      const lower = w.toLocaleLowerCase('en-GB');
      if (inputWords.has(lower)) continue;
      const s = stem(w);
      if (NON_LATIN.test(w)) {
        // Other alphabets, or a Latin word with a look-alike letter in it: only if the owner typed exactly this.
        add('script', w);
        continue;
      }
      if (inputStems.has(s)) continue;
      const kind = restricted(w);
      if (kind) add(kind, w);
      else if (BRAND_SET.has(s) || BRAND_SET.has(lower)) add('name', w);
      else if (/^\p{Lu}{2,}$/u.test(w)) add('name', w);
    }
    // A capital in the middle of a sentence that the owner did not write is a name (Marley, Ludlow, a town).
    for (const m of text.matchAll(/(?<=[\p{L}\p{M}\p{Nd},;:)]\s+)\p{Lu}[\p{L}\p{M}]*/gu)) {
      const lower = m[0].toLocaleLowerCase('en-GB');
      if (!inputWords.has(lower) && !inputStems.has(stem(m[0]))) add('name', m[0]);
    }
  }
  return found;
}
