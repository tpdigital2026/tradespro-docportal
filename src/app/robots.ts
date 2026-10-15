import type { MetadataRoute } from 'next';

/** DocPortal is private and invite-only: nothing is to be crawled or indexed. No sitemap on purpose. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', disallow: '/' }] };
}
