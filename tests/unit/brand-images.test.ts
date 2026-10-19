import { describe, expect, it } from 'vitest';
import { brandImagesFrom, imageFromRow, shareCardFromRow } from '../../src/lib/brand';
import { DEMO_BRAND, TRADESPRO_BRAND } from '../../src/lib/brand-core';

const T = '11111111-1111-4111-8111-111111111111';
const files = ['hero-800.jpg', 'hero-1400.jpg', 'hero-800.webp', 'hero-1400.webp', 'van-1600.jpg', 'og.jpg'];
const list = () => files;

describe('brand images from the brand kit', () => {
  it('builds a responsive banner from every width on disk', () => {
    const img = imageFromRow('fjc', T, { kind: 'hero_image', storage_path: `${T}/hero-1400.jpg`, width: 1400, height: 864, alt: '' }, list);
    expect(img).toEqual({ src: '/brands/fjc/hero-1400.jpg', width: 1400, height: 864, srcSetJpg: '/brands/fjc/hero-800.jpg 800w, /brands/fjc/hero-1400.jpg 1400w', srcSetWebp: '/brands/fjc/hero-800.webp 800w, /brands/fjc/hero-1400.webp 1400w', alt: '' });
  });

  it('drops anything not ours: another tenant\'s path, a missing file, odd names, silly sizes', () => {
    const row = { kind: 'hero_image', storage_path: `${T}/hero-1400.jpg`, width: 1400, height: 864, alt: '' };
    expect(imageFromRow('fjc', '22222222-2222-4222-8222-222222222222', row, list)).toBeNull();
    expect(imageFromRow('fjc', T, { ...row, storage_path: `${T}/hero-2000.jpg` }, list)).toBeNull();
    expect(imageFromRow('fjc', T, { ...row, storage_path: `${T}/../hero-1400.jpg` }, list)).toBeNull();
    expect(imageFromRow('fjc', T, { ...row, width: 99999 }, list)).toBeNull();
    expect(imageFromRow('Bad Slug', T, row, list)).toBeNull();
    expect(shareCardFromRow('fjc', T, { kind: 'share_card', storage_path: `${T}/og.jpg`, width: 1200, height: 630, alt: 'x' }, () => true)?.url).toBe('/brands/fjc/og.jpg');
    expect(shareCardFromRow('fjc', T, { kind: 'share_card', storage_path: `${T}/og.jpg`, width: 800, height: 630, alt: 'x' }, () => true)).toBeNull();
  });

  it('a business with no rows gets no banner, photo or card', () => {
    expect(brandImagesFrom('acme', T, [], list, () => true)).toEqual({ heroImage: null, signInPhoto: null, shareCard: null });
    expect(brandImagesFrom(null, T, [{ kind: 'hero_image', storage_path: `${T}/hero-1400.jpg`, width: 1400, height: 864, alt: '' }], list)).toEqual({ heroImage: null, signInPhoto: null, shareCard: null });
  });

  it('the banner image follows the brand data, not the slug', () => {
    expect(DEMO_BRAND.heroImage?.src).toBe('/brands/fjc/hero-wide-1400.jpg');
    expect(TRADESPRO_BRAND.heroImage ?? null).toBeNull();
  });
});

describe('FJC brand images: one list for the seed and demo mode', () => {
  it('demo mode builds its banner and sign-in photo from FJC_BRAND_IMAGES and the files on disk', async () => {
    const { demoBrand } = await import('../../src/lib/brand');
    const { FJC_BRAND_IMAGES } = await import('../../src/lib/brand-images-fjc');
    const hero = FJC_BRAND_IMAGES.find((i) => i.kind === 'hero_image')!;
    const b = demoBrand(() => [hero.file, hero.file.replace(/-\d+\.jpg$/, '-800.jpg'), hero.file.replace(/\.jpg$/, '.webp'), 'van-1600.jpg']);
    expect(b.heroImage?.src).toBe(`/brands/fjc/${hero.file}`);
    expect(b.heroImage?.width).toBe(hero.width);
    expect(b.heroImage?.srcSetJpg).toContain('-800.jpg 800w');
    // A wider export dropped next to it joins the srcset with no code change.
    const wide = demoBrand(() => [hero.file, 'hero-wide-2400.jpg', 'van-1600.jpg']);
    expect(wide.heroImage?.srcSetJpg).toContain('/brands/fjc/hero-wide-2400.jpg 2400w');
  });
});
