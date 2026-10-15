import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/outfit/latin-500.css';
import '@fontsource/outfit/latin-600.css';
import '@fontsource/outfit/latin-700.css';
import '@fontsource/work-sans/latin-400.css';
import '@fontsource/work-sans/latin-500.css';
import '@fontsource/work-sans/latin-600.css';
import '../styles/tokens.css';
import '../styles/app.css';
import { APP_DESCRIPTION, APP_NAME, APP_SHORT_NAME, ROBOTS, SHARE_CARD, siteUrl, THEME_NAVY } from '../lib/site';

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
  description: APP_DESCRIPTION,
  applicationName: APP_NAME,
  robots: ROBOTS,
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: { capable: true, title: APP_SHORT_NAME, statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false, email: false, address: false },
  openGraph: { type: 'website', siteName: APP_NAME, title: APP_NAME, description: APP_DESCRIPTION, images: [SHARE_CARD], locale: 'en_GB' },
  twitter: { card: 'summary_large_image', title: APP_NAME, description: APP_DESCRIPTION, images: [SHARE_CARD.url] },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light',
  // One light theme with a navy header in both schemes, so the browser bar stays navy either way.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_NAVY },
    { media: '(prefers-color-scheme: dark)', color: THEME_NAVY },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
