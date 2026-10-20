import type { NextConfig } from 'next';

/** Sent on every response, pages, API routes and files alike: this is a private tool, never to be indexed. */
export const ROBOTS_HEADER = { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' };

// Rendering reads the document stylesheet, the self-hosted fonts, the brand files and the locked templates' images
// (src/templates/library) from disk at request time, so the serverless bundle must carry them. Nothing imports them, so the file tracer cannot find them on its own.
const RENDER_FILES = ['./src/themes/fjc/base.css', './node_modules/@fontsource/*/files/*-latin-*-normal.woff2', './public/brands/**/*', './src/templates/library/**/*'];

// The compressed Chromium for Vercel (chromium.br, al2023.tar.br, fonts.tar.br, swiftshader.tar.br). @sparticuz/chromium
// finds them next to its own files at run time, so they are never imported and must be listed here, or launch fails with
// 'The input directory ".../@sparticuz/chromium/bin" does not exist'. npm run check:render-bundle proves they are traced.
const CHROMIUM_FILES = ['./node_modules/@sparticuz/chromium/bin/**'];

/** Every route that draws a document or decodes a signature picture in the browser. */
const RENDER_ROUTES = ['/api/documents/**', '/documents/**', '/api/settings/signature'];

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  // Kept as plain node_modules in the function (never bundled): @sparticuz/chromium resolves its bin folder from its own
  // location, and the browser drivers spawn processes and load protocol files at run time.
  serverExternalPackages: ['@sparticuz/chromium', 'puppeteer-core', 'playwright-core'],
  outputFileTracingIncludes: Object.fromEntries(RENDER_ROUTES.map((r) => [r, [...RENDER_FILES, ...CHROMIUM_FILES]])),
  async headers() {
    return [{ source: '/:path*', headers: [ROBOTS_HEADER] }];
  },
};

export default config;
