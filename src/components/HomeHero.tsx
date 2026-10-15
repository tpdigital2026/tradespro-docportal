import type { TenantBrand } from '../lib/brand-core';

/**
 * The Home banner. FJC has the banknotes image the owner chose: shown whole, at its natural shape, never cropped,
 * its own navy top and white bottom fades doing the blending. Every other business gets a plain band in navy.
 * The image is decorative (alt=""), the words carry the meaning.
 */
export function homeBannerFor(brand: TenantBrand): boolean {
  return brand.slug === 'fjc';
}

export function HomeHero({ brand, hello, children }: { brand: TenantBrand; hello: string; children: React.ReactNode }) {
  const withImage = homeBannerFor(brand);
  return (
    <section className={`hero${withImage ? ' has-image' : ''}`} aria-labelledby="home-h">
      <div className="hero-copy">
        <p className="hero-hello">{hello}</p>
        <h1 id="home-h" className="hero-h">{children}</h1>
      </div>
      {withImage ? (
        <picture className="hero-art">
          <source type="image/webp" srcSet="/images/home-hero-800.webp 800w, /images/home-hero-1400.webp 1400w" sizes="(min-width: 900px) calc(100vw - 16rem), 100vw" />
          <img src="/images/home-hero-1400.jpg" srcSet="/images/home-hero-800.jpg 800w, /images/home-hero-1400.jpg 1400w" sizes="(min-width: 900px) calc(100vw - 16rem), 100vw" width={1400} height={864} alt="" fetchPriority="high" decoding="async" />
        </picture>
      ) : null}
    </section>
  );
}
