import { BRANDS } from './brands';

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

export type InventionKind = 'number' | 'product' | 'unit' | 'claim' | 'name' | 'script';
export interface Invention {
  kind: InventionKind;
  word: string;
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', thousand: '1000', dozen: '12', half: '0.5', double: '2', triple: '3', twice: '2', single: '1',
};

const PRODUCT_WORDS = new Set([
  'osb', 'ply', 'plywood', 'felt', 'epdm', 'grp', 'fibreglass', 'fiberglass', 'rubber', 'bitumen', 'lead', 'zinc', 'copper', 'aluminium',
  'aluminum', 'steel', 'slate', 'tile', 'upvc', 'pvc', 'timber', 'insulation', 'membrane', 'underlay', 'underfelt', 'batten', 'mortar',
  'cement', 'sealant', 'mastic', 'concrete', 'brick', 'glass', 'plastic', 'polycarbonate', 'fascia', 'soffit', 'gutter', 'downpipe',
  'flashing', 'ridge', 'hip', 'valley', 'joist', 'rafter', 'scaffold', 'scaffolding', 'skip', 'chimney', 'skylight', 'velux', 'lantern',
  'decking', 'deck', 'cladding', 'render', 'paint', 'adhesive', 'screw', 'nail', 'bolt', 'vent', 'outlet', 'drain', 'drainage',
  'stone', 'wood', 'metal', 'iron', 'tar', 'asphalt', 'resin', 'foam', 'vapour', 'vapor', 'breathable', 'warm', 'lath', 'truss',
]);

const UNIT_WORDS = new Set([
  'mm', 'cm', 'metre', 'meter', 'inch', 'ft', 'foot', 'feet', 'yard', 'litre', 'liter', 'kg', 'tonne', 'sqm', 'm', 'year', 'month', 'week',
  'millimetre', 'centimetre', 'kilogram', 'gram', 'hour', 'minute', 'percent', 'pound', 'pence', 'sq', 'sqft', 'yr',
]);

const CLAIM_WORDS = new Set([
  'guarantee', 'guaranteed', 'guaranteeing', 'warranty', 'warranted', 'lifetime', 'certified', 'accredited', 'approved', 'compliant',
  'compliance', 'regulation', 'british', 'standard', 'bs', 'en', 'nhbc', 'insured', 'insurance', 'free', 'premium', 'durable',
  'lasting', 'quality', 'best', 'superior', 'weathertight', 'watertight', 'leakproof', 'proof', 'maintenance', 'excellent', 'finest',
  'leading', 'trusted', 'reliable', 'unbeatable', 'cheap', 'affordable', 'discount', 'guarantees',
]);

const BRAND_SET = new Set(BRANDS);

const DIGITS = /\p{Nd}+(?:[.,]\p{Nd}+)*|[¼½¾]/gu;
const WORD = /[\p{L}\p{M}]+/gu;
const NON_LATIN = /[^\p{Script=Latin}\p{M}]/u;

/** Plural stripped, lowercase. Deliberately simple: one rule set for the input and the output. */
function stem(w: string): string {
  const x = w.toLocaleLowerCase('en-GB');
  if (x.length > 4 && x.endsWith('ies')) return `${x.slice(0, -3)}y`;
  if (x.length > 4 && /(?:ch|sh|x|ss)es$/.test(x)) return x.slice(0, -2);
  if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) return x.slice(0, -1);
  return x;
}

const norm = (t: string) => t.normalize('NFKC');

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
      if (PRODUCT_WORDS.has(s)) add('product', w);
      else if (UNIT_WORDS.has(s)) add('unit', w);
      else if (CLAIM_WORDS.has(s)) add('claim', w);
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
