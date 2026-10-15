/**
 * Word forms by stem and suffix rules. NOT fuzzy matching: a word is looked up as itself and as the few exact
 * bases that a listed suffix leaves behind, so painted gives paint but point never does, and after never gives
 * rafter. (rafter/after, joist/joint, paint/point, ridge/bridge, slate/slats, steel/steep all stay different.)
 */

/** Plural stripped, lowercase. */
export function pluralStem(w: string): string {
  const x = w.toLocaleLowerCase('en-GB');
  if (x.length > 4 && x.endsWith('ies')) return `${x.slice(0, -3)}y`;
  if (x.length > 4 && /(?:ch|sh|x|ss)es$/.test(x)) return x.slice(0, -2);
  if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) return x.slice(0, -1);
  return x;
}

// [suffix, extra letters that may have been dropped before it]
const SUFFIXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['ations', ['ate']], ['ation', ['ate']], ['ating', ['ate', 'e']], ['ated', ['ate', 'e']], ['ates', ['ate', 'e']],
  ['ings', ['e']], ['ing', ['e']], ['ers', ['e']], ['er', ['e']], ['ed', ['e']], ['es', []], ['s', []], ['ly', []],
];

/** The word itself plus the bases the suffix rules can give. All exact strings. */
export function stemCandidates(word: string): string[] {
  const w = word.toLocaleLowerCase('en-GB');
  const out = new Set<string>([w, pluralStem(w)]);
  for (const [suffix, extra] of SUFFIXES) {
    if (!w.endsWith(suffix)) continue;
    const rest = w.slice(0, -suffix.length);
    if (rest.length < 3) continue;
    out.add(rest);
    for (const e of extra) out.add(rest + e);
    // skipped -> skip, hipped -> hip
    if (/([^aeiou])\1$/.test(rest)) out.add(rest.slice(0, -1));
  }
  return [...out];
}
