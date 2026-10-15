import Image from 'next/image';
import type { ReactNode } from 'react';
import { brandStyle, type BrandImage, type TenantBrand } from '../lib/brand-core';
import { PoweredBy } from './PoweredBy';
import { SamplePage } from './SamplePage';

/**
 * The sign-in screen shared by /login, /{slug} and the demo preview. Public by design: it shows the
 * business's logo and accent and nothing about anyone's account.
 * Desktop: white form panel on the left, navy panel on the right: FJC's own van photo for FJC, a wordless
 * document illustration for everyone else. Phone: navy strip with the logo (and FJC's photo), white form below.
 */
/** The business's own sign-in photo from its brand kit (FJC: Ben and the van). Only for that business's address. */
function BrandPhoto({ img, className, sizes }: { img: BrandImage; className: string; sizes: string }) {
  return (
    <picture className={className}>
      {img.srcSetWebp ? <source type="image/webp" srcSet={img.srcSetWebp} sizes={sizes} /> : null}
      <img src={img.src} srcSet={img.srcSetJpg || undefined} sizes={sizes} width={img.width} height={img.height} alt={img.alt} />
    </picture>
  );
}

export function SignIn({ brand, children }: { brand: TenantBrand; children: ReactNode }) {
  const dark = brand.logoDark;
  const photo = brand.signInPhoto ?? null;
  return (
    <div className="signin brandroot" style={brandStyle(brand)}>
      <header className="signin-bar">
        <Image src={dark.url} width={dark.width} height={dark.height} alt={`${brand.name} logo`} className="brand-logo" priority />
      </header>
      {photo ? <BrandPhoto img={photo} className="signin-photo-m" sizes="100vw" /> : null}

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
          <BrandPhoto img={photo} className="signin-photo" sizes="50vw" />
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
