/**
 * The guard against invention. Whatever the engine, the wording that comes back may not contain a figure, a
 * material or product, a unit, a claim, or a name that is not in what the owner wrote. This does not prove the
 * wording is faithful (nothing can), it stops the failures that matter on a quotation: invented numbers, products,
 * standards and promises.
 */

export type InventionKind = 'number' | 'product' | 'unit' | 'claim' | 'name';
export interface Invention {
  kind: InventionKind;
  word: string;
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', thousand: '1000', dozen: '12', half: '0.5', double: '2', triple: '3', twice: '2',
};

const PRODUCT_WORDS = new Set([
  'osb', 'ply', 'plywood', 'felt', 'epdm', 'grp', 'fibreglass', 'fiberglass', 'rubber', 'bitumen', 'lead', 'zinc', 'copper', 'aluminium',
  'aluminum', 'steel', 'slate', 'tile', 'upvc', 'pvc', 'timber', 'insulation', 'membrane', 'underlay', 'underfelt', 'batten', 'mortar',
  'cement', 'sealant', 'mastic', 'concrete', 'brick', 'glass', 'plastic', 'polycarbonate', 'fascia', 'soffit', 'gutter', 'downpipe',
  'flashing', 'ridge', 'hip', 'valley', 'joist', 'rafter', 'scaffold', 'scaffolding', 'skip', 'chimney', 'skylight', 'velux', 'lantern',
  'decking', 'deck', 'cladding', 'render', 'paint', 'adhesive', 'screw', 'nail', 'bolt', 'vent', 'outlet', 'drain', 'drainage',
]);

const UNIT_WORDS = new Set([
  'mm', 'cm', 'metre', 'meter', 'inch', 'ft', 'foot', 'feet', 'yard', 'litre', 'liter', 'kg', 'tonne', 'sqm', 'm2', 'year', 'month', 'week',
]);

const CLAIM_WORDS = new Set([
  'guarantee', 'guaranteed', 'warranty', 'warranted', 'lifetime', 'certified', 'accredited', 'approved', 'compliant', 'compliance',
  'regulation', 'british', 'standard', 'bs', 'nhbc', 'insured', 'insurance', 'free', 'premium', 'durable', 'longlasting', 'quality',
  'best', 'superior', 'weathertight', 'watertight', 'leakproof', 'maintenancefree', 'guaranteeing',
]);

const WORD = /[\p{L}][\p{L}'’-]*/gu;
const DIGITS = /\d+(?:[.,]\d+)*|[¼½¾]/g;

const stem = (w: string): string => {
  const x = w.toLocaleLowerCase('en-GB').replace(/[’'-]/g, '');
  if (x.length > 4 && x.endsWith('ies')) return `${x.slice(0, -3)}y`;
  if (x.length > 4 && x.endsWith('es') && /(?:ch|sh|x|ss)es$/.test(x)) return x.slice(0, -2);
  if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) return x.slice(0, -1);
  return x;
};

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** A word is known when the owner wrote it, in any plural, or a close misspelling of it (a speech-to-text fix). */
function known(word: string, inputStems: Set<string>): boolean {
  const s = stem(word);
  if (inputStems.has(s)) return true;
  const allowed = s.length >= 8 ? 2 : s.length >= 5 ? 1 : 0;
  if (allowed === 0) return false;
  for (const t of inputStems) if (distance(s, t, allowed) <= allowed) return true;
  return false;
}

function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DIGITS)) out.push(m[0] === '½' ? '0.5' : m[0] === '¼' ? '0.25' : m[0] === '¾' ? '0.75' : m[0].replace(/,/g, ''));
  for (const m of text.toLocaleLowerCase('en-GB').matchAll(WORD)) {
    const n = NUMBER_WORDS[m[0]];
    if (n) out.push(n);
  }
  return out;
}

const strip = (t: string) => t.replace(/\bsteps?\s+\d+\b/gi, ' ');

export function findInventions(inputTexts: readonly string[], outputTexts: readonly string[]): Invention[] {
  const input = inputTexts.join('\n');
  const inputNumbers = new Set(numbersIn(input));
  const inputStems = new Set([...input.matchAll(WORD)].map((m) => stem(m[0])));
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
    const text = strip(raw);
    for (const n of numbersIn(text)) if (!inputNumbers.has(n)) add('number', n);
    for (const sym of text.match(/[£$€%]/g) ?? []) if (!inputSymbols.has(sym)) add('number', sym);
    let sentenceStart = true;
    let last = 0;
    for (const m of text.matchAll(WORD)) {
      const w = m[0];
      const between = text.slice(last, m.index);
      if (/[.!?:]\s*$/.test(between)) sentenceStart = true;
      last = (m.index ?? 0) + w.length;
      const s = stem(w);
      const flat = w.toLocaleLowerCase('en-GB').replace(/[’'-]/g, '');
      const isKnown = known(w, inputStems);
      if (!isKnown) {
        if (PRODUCT_WORDS.has(s)) add('product', w);
        else if (UNIT_WORDS.has(s) || UNIT_WORDS.has(flat)) add('unit', w);
        else if (CLAIM_WORDS.has(s) || CLAIM_WORDS.has(flat)) add('claim', w);
        else if (/^[A-Z]{2,}$/.test(w)) add('name', w);
        else if (!sentenceStart && /^\p{Lu}/u.test(w)) add('name', w);
      }
      sentenceStart = false;
    }
  }
  return found;
}
