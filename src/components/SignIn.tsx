import Image from 'next/image';
import type { ReactNode } from 'react';
import { brandStyle, type TenantBrand } from '../lib/brand-core';
import { PoweredBy } from './PoweredBy';
import { SamplePage } from './SamplePage';

/**
 * The sign-in screen shared by /login, /{slug} and the demo preview. Public by design: it shows the
 * business's logo and accent and nothing about anyone's account.
 * Desktop: white form panel on the left, navy panel on the right: FJC's own van photo for FJC, a wordless
 * document illustration for everyone else. Phone: navy strip with the logo (and FJC's photo), white form below.
 */
/** FJC's own photo (Ben and the van). Only ever shown for the FJC address. */
function VanPhoto({ className, sizes }: { className: string; sizes: string }) {
  return (
    <picture className={className}>
      <source type="image/webp" srcSet="/brands/fjc/van-900.webp 900w, /brands/fjc/van-1600.webp 1600w" sizes={sizes} />
      <img src="/brands/fjc/van-1600.jpg" srcSet="/brands/fjc/van-900.jpg 900w, /brands/fjc/van-1600.jpg 1600w" sizes={sizes} width={1600} height={1200} alt="FJC Roofing van" />
    </picture>
  );
}

export function SignIn({ brand, children }: { brand: TenantBrand; children: ReactNode }) {
  const dark = brand.logoDark;
  const photo = brand.slug === 'fjc';
  return (
    <div className="signin brandroot" style={brandStyle(brand)}>
      <header className="signin-bar">
        <Image src={dark.url} width={dark.width} height={dark.height} alt={`${brand.name} logo`} className="brand-logo" priority />
      </header>
      {photo ? <VanPhoto className="signin-photo-m" sizes="100vw" /> : null}

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

      {photo ? (
        <aside className="signin-art is-photo">
          <VanPhoto className="signin-photo" sizes="50vw" />
          <p className="signin-photo-cap">Quotes, invoices, receipts and guarantees, ready to send.</p>
        </aside>
      ) : (
        <aside className="signin-art">
          <figure>
            <SamplePage />
            <figcaption>Quotes, invoices, receipts and guarantees, ready to send.</figcaption>
          </figure>
        </aside>
      )}
    </div>
  );
}
