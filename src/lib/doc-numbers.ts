/**
 * Document numbers the way the owner's real documents carry them.
 *
 *   quote           QT-{CODE}-{NNN}          QT-GW-001
 *   invoices        INV-{CODE}-{NNN}-D / -B  INV-GW-001-D
 *   receipts        RCP-{CODE}-{NNN}-D / -B  RCP-GW-001-D
 *   guarantee       GC-{CODE}-{NNN}          GC-GW-001
 *
 * CODE is the initials of the property's street name (Grafton Way gives GW), two or three letters. A commercial job
 * with no usable street uses the client's initials. NNN is the running number for that code, 001, 002 and so on.
 * Invoices, receipts and guarantees reuse the quote's code and number, so they are built from the quote number's
 * "stem" (GW-001), never from the whole quote number. Older numbers such as FJC1003 have no QT- in front: their stem
 * is the whole number, so FJC1003 keeps giving INV-FJC1003-D and stays valid.
 *
 * Pure: no database. The data layer asks it for the next number from the numbers already used.
 */

/** The part of a quote number that invoices, receipts and guarantees reuse. QT-GW-001 gives GW-001; FJC1003 stays FJC1003. */
export function jobStem(quoteNumber: string): string {
  const m = /^QT-(.+)$/i.exec(quoteNumber);
  return m ? m[1] : quoteNumber;
}

/** Both forms of a quote number that would produce the same invoice numbers (the quote number as typed, and its stem). */
export function stemVariants(quoteNumber: string): string[] {
  const stem = jobStem(quoteNumber);
  return stem === quoteNumber ? [quoteNumber, `QT-${quoteNumber}`] : [quoteNumber, stem];
}

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof']);
const UNIT_WORDS = /^(?:flat|apartment|apt|unit|suite|room|plot|floor)$/i;
const HOUSE_NUMBER = /^\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?[,.]?$/i;

/** Letters only, from words such as "St John's" (the apostrophe is dropped, hyphenated words count once). */
const lettersOf = (w: string) => w.normalize('NFKD').replace(/[^A-Za-z]/g, '');

function initialsOf(words: string[]): string {
  const parts = words.map(lettersOf).filter((w) => w !== '');
  if (parts.length === 0) return '';
  // One word ("Broadway") has no second initial: its first two letters stand in.
  if (parts.length === 1) return parts[0].length >= 2 ? parts[0].slice(0, 2).toUpperCase() : '';
  return parts.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

/** The street name from the first line of an address: the house number, flat and unit words are dropped. */
export function streetNameOf(addressFirstLine: string): string {
  const words = addressFirstLine.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // "Flat 2", "Unit 4B", "Apartment 12": a unit word and the token after it.
  while (i < words.length && UNIT_WORDS.test(words[i].replace(/[,.]/g, ''))) i += 2;
  // "33", "62A", "10-12", "2D": the house number.
  while (i < words.length && HOUSE_NUMBER.test(words[i])) i += 1;
  return words.slice(i).join(' ');
}

/**
 * The job code to suggest: the street's initials from the property address (first line), or the client's initials when
 * the address has no street. Empty when neither gives two letters, so the owner types one.
 */
export function suggestJobCode(propertyAddress: string, clientName = ''): string {
  const firstLine = propertyAddress.split(/[,\n]/)[0] ?? '';
  const street = initialsOf(streetNameOf(firstLine).split(/\s+/));
  if (street.length >= 2) return street;
  const clientWords = clientName.trim().split(/\s+/).filter((w, i) => !(i === 0 && TITLES.has(w.replace(/\./g, '').toLowerCase())));
  const client = clientWords.length > 1 ? clientWords.slice(0, 3).map((w) => lettersOf(w)[0] ?? '').join('').toUpperCase() : initialsOf(clientWords);
  return client.length >= 2 ? client : '';
}

export const QUOTE_RUNNING_WIDTH = 3;

/** QT-GW-001 */
export function quoteNumberFor(code: string, running: number): string {
  return `QT-${code.toUpperCase()}-${String(running).padStart(QUOTE_RUNNING_WIDTH, '0')}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The next free quote number for a code, from every quote number already used (any order). It goes one past the highest
 * running number for that code, so a deleted or skipped number is never reused. A revision ending (QT-GW-001-2) counts as
 * its base number. Empty when the code is empty.
 */
export function nextQuoteNumber(code: string, used: readonly string[]): string {
  const c = code.trim().toUpperCase();
  if (!c) return '';
  const taken = new Set(used.map((u) => u.toUpperCase()));
  const re = new RegExp(`^QT-${escapeRe(c)}-(\\d{1,6})(?:-\\d{1,3})?$`, 'i');
  let max = 0;
  for (const u of used) {
    const m = re.exec(u);
    if (m) max = Math.max(max, Number(m[1]));
  }
  for (let n = max + 1; n < max + 1000; n += 1) {
    const candidate = quoteNumberFor(c, n);
    if (!taken.has(candidate) && !taken.has(jobStem(candidate).toUpperCase())) return candidate;
  }
  return '';
}

/** Does this look like a number in Ben's shape: QT-{2 to 4 letters}-{digits}, optionally with a revision ending? */
export function isCodedQuoteNumber(n: string): boolean {
  return /^QT-[A-Z]{2,4}-\d{3,6}(?:-\d{1,3})?$/i.test(n);
}
