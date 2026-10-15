import type { NextConfig } from 'next';

/** Sent on every response, pages, API routes and files alike: this is a private tool, never to be indexed. */
export const ROBOTS_HEADER = { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' };

// Rendering reads the document stylesheet, the self-hosted fonts and the brand files from disk at request time, so the
// serverless bundle must carry them. Chromium for serverless is loaded lazily and kept out of the bundle.
const RENDER_FILES = ['./src/themes/fjc/base.css', './node_modules/@fontsource/*/files/*-latin-*-normal.woff2', './public/brands/**/*'];

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ['@sparticuz/chromium', 'playwright-core'],
  outputFileTracingIncludes: {
    '/api/documents/**': RENDER_FILES,
    '/documents/**': RENDER_FILES,
  },
  async headers() {
    return [{ source: '/:path*', headers: [ROBOTS_HEADER] }];
  },
};

export default config;
