import type { NextConfig } from 'next';

/** Sent on every response, pages, API routes and files alike: this is a private tool, never to be indexed. */
export const ROBOTS_HEADER = { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' };

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{ source: '/:path*', headers: [ROBOTS_HEADER] }];
  },
};

export default config;
