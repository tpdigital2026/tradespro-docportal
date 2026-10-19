import type { TenantBrand } from '../lib/brand-core';

/**
 * The Home banner: the business's own banner image from its brand kit (FJC: the banknotes image the owner chose), in a
 * band of capped height (app.css --hero-band-h) so the document tiles start above the fold; the image covers the band,
 * anchored by --hero-focus. A business with no banner image gets a plain band. The image is decorative (alt=""), the
 * words carry the meaning.
 */
export function homeBannerFor(brand: TenantBrand) {
  return brand.heroImage ?? null;
}

export function HomeHero({ brand, hello, children }: { brand: TenantBrand; hello: string; children: React.ReactNode }) {
  const img = homeBannerFor(brand);
  const withImage = img !== null;
  return (
    <section className={`hero${withImage ? ' has-image' : ''}`} aria-labelledby="home-h">
      <div className="hero-copy">
        <p className="hero-hello">{hello}</p>
        <h1 id="home-h" className="hero-h">{children}</h1>
      </div>
      {img ? (
        <picture className="hero-art">
          {img.srcSetWebp ? <source type="image/webp" srcSet={img.srcSetWebp} sizes="(min-width: 900px) calc(100vw - 16rem), 100vw" /> : null}
          <img src={img.src} srcSet={img.srcSetJpg || undefined} sizes="(min-width: 900px) calc(100vw - 16rem), 100vw" width={img.width} height={img.height} alt="" fetchPriority="high" decoding="async" />
        </picture>
      ) : null}
    </section>
  );
}
