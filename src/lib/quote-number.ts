/**
 * Suggests the next free quote number from the ones already used, newest first.
 * It follows the owner's own pattern (prefix, then a number, keeping leading zeros) and skips any number already taken.
 * With no history it suggests nothing: the owner types the first one.
 */
export function suggestNextNumber(usedNewestFirst: readonly string[]): string {
  const taken = new Set(usedNewestFirst);
  for (const n of usedNewestFirst) {
    const m = /^(.*?)(\d{1,12})$/.exec(n);
    if (!m) continue;
    const prefix = m[1];
    const width = m[2].length;
    let next = BigInt(m[2]) + 1n;
    for (let i = 0; i < 10_000; i++, next++) {
      const candidate = `${prefix}${String(next).padStart(width, '0')}`;
      if (candidate.length > 40) break;
      if (!taken.has(candidate)) return candidate;
    }
  }
  return '';
}
