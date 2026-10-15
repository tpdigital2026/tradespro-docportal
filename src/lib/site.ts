import type { Metadata } from 'next';
import type { TenantBrand } from './brand-core';

/**
 * Site-wide metadata for a PRIVATE, invite-only tool. Nothing here is for ranking: every page is noindex, the
 * share cards say nothing about anyone's account, and the canonical host comes from the environment.
 */
const DEFAULT_SITE_URL = 'https://docs.tradesprodigital.io';

export function siteUrl(env: Record<string, string | undefined> = process.env): URL {
  const raw = env.NEXT_PUBLIC_SITE_URL?.trim();
  try {
    const u = new URL(raw || DEFAULT_SITE_URL);
    return u.protocol === 'https:' || u.hostname === 'localhost' ? u : new URL(DEFAULT_SITE_URL);
  } catch {
    return new URL(DEFAULT_SITE_URL);
  }
}

export const APP_NAME = 'TradesPro DocPortal';
export const APP_SHORT_NAME = 'DocPortal';
export const APP_DESCRIPTION = 'Quotes, invoices, receipts and guarantees for your business, in one place.';

/** Mirrors --navy-900 and --paper in src/styles/tokens.css (a test keeps them in step). */
export const THEME_NAVY = '#071626';
export const THEME_PAPER = '#ffffff';

export const ROBOTS: NonNullable<Metadata['robots']> = {
  index: false,
  follow: false,
  noarchive: true,
  nocache: true,
  googleBot: { index: false, follow: false, noarchive: true, noimageindex: true },
};

export const SHARE_CARD = { url: '/og/docportal.png', width: 1200, height: 630, alt: 'TradesPro DocPortal' } as const;
const FJC_CARD = { url: '/brands/fjc/og.jpg', width: 1200, height: 630, alt: 'FJC Roofing Ltd DocPortal' } as const;

export const SIGNIN_DESCRIPTION = 'Sign in to your DocPortal with a code sent to your email. Invite only.';

/** The share card for a sign-in page. Only FJC has its own card; every other address gets the neutral one. */
export function shareCardFor(brand: TenantBrand) {
  return brand.slug === 'fjc' ? FJC_CARD : SHARE_CARD;
}

/**
 * Metadata for a sign-in page. A business's own address shows its name; the plain sign-in, an unknown address and
 * a reserved word all get exactly the same metadata, so the address cannot be used to find out who exists.
 */
export function signInMetadata(brand: TenantBrand): Metadata {
  const card = shareCardFor(brand);
  const title = brand.isOwnBrand ? `Sign in | ${APP_NAME}` : `Sign in | ${brand.name}`;
  return {
    title: { absolute: title },
    description: SIGNIN_DESCRIPTION,
    openGraph: { type: 'website', siteName: APP_NAME, title, description: SIGNIN_DESCRIPTION, images: [card], locale: 'en_GB' },
    twitter: { card: 'summary_large_image', title, description: SIGNIN_DESCRIPTION, images: [card.url] },
  };
}
