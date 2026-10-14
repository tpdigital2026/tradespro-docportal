import Image from 'next/image';
import type { ReactNode } from 'react';
import { brandStyle, type TenantBrand } from '../lib/brand-core';
import { PoweredBy } from './PoweredBy';

/**
 * The sign-in screen shared by /login, /{slug} and the demo preview. Public by design: it shows the
 * business's logo and accent and nothing about anyone's account.
 * Desktop: white form panel on the left, navy panel with a dummy-data sample page on the right.
 * Phone: navy strip with the logo, white form below.
 */
export function SignIn({ brand, children }: { brand: TenantBrand; children: ReactNode }) {
  const dark = brand.logoDark;
  return (
    <div className="signin brandroot" style={brandStyle(brand)}>
      <header className="signin-bar">
        <Image src={dark.url} width={dark.width} height={dark.height} alt={`${brand.name} logo`} className="brand-logo" priority />
      </header>

      <main id="main" className="signin-main">
        <div className="signin-brand">
          {brand.logoLight ? (
            <Image src={brand.logoLight.url} width={brand.logoLight.width} height={brand.logoLight.height} alt={`${brand.name} logo`} className="signin-brand-colour" priority />
          ) : (
            <span className="signin-brand-badge">
              <Image src={dark.url} width={dark.width} height={dark.height} alt={`${brand.name} logo`} className="brand-logo" priority />
            </span>
          )}
        </div>

        <div className="signin-body">{children}</div>

        <footer className="signin-foot">
          <p>Not invited yet? Access is by invitation from TradesPro Digital.</p>
          {brand.isOwnBrand ? null : <PoweredBy variant="light" />}
        </footer>
      </main>

      <aside className="signin-art">
        <figure>
          <Image src="/login-sample.png" width={1588} height={2246} alt="Sample quotation (dummy data)" sizes="26rem" />
          <figcaption>Quotes, invoices, receipts and guarantees, ready to send.</figcaption>
        </figure>
      </aside>
    </div>
  );
}
