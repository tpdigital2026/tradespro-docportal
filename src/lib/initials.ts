/** Up to two initials for an avatar: first and last word, ignoring titles like Mr and Mrs. Display only. */
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr']);

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const parts = words.length > 1 ? words.filter((w, i) => i > 0 || !TITLES.has(w.replace(/\./g, '').toLowerCase())) : words;
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase() || '?';
}
