import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ usePathname: () => '/customers', useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

import { Shell } from '../../src/components/Shell';
import { DEMO_BRAND } from '../../src/lib/brand-core';

describe('the business logo in the app shell', () => {
  it('is a link Home, named "Home", in the rail and in the phone header', () => {
    const html = renderToStaticMarkup(createElement(Shell, { brand: DEMO_BRAND, userName: 'Dummy Owner', children: createElement('p', null, 'x') }));
    const links = html.match(/<a[^>]*class="brand-home"[^>]*>/g) ?? [];
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a).toContain('href="/"');
      expect(a).toContain('aria-label="Home"');
    }
  });
});
