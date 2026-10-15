/**
 * The confirmation the owner ticks before a document is finalised, and the shorter reminder shown under Download.
 *
 * DRAFT WORDING: flagged for a solicitor to review before wider use. It is tenant data (tenant_defaults.terms.confirmation)
 * with this as the default, so it can be changed per business without a code change. Pure and browser-safe.
 */

export const DEFAULT_CONFIRMATION = {
  text: 'I have checked every detail on this document, including names, addresses, scope and prices. DocPortal and TradesPro Digital provide the tool only and are not responsible for what the document says. It is my responsibility to check it before I send it to my customer.',
  version: 'default-1',
} as const;

export const SEND_REMINDER = 'Check all details before you send this to your customer.';

export interface Confirmation {
  text: string;
  /** Recorded in the audit log (never the text itself), so it is known which wording was agreed to. */
  version: string;
}

export function confirmationFor(wording: { confirmation?: Confirmation } | null | undefined): Confirmation {
  const c = wording?.confirmation;
  return c && c.text.trim() !== '' ? { text: c.text.trim(), version: c.version } : { ...DEFAULT_CONFIRMATION };
}
