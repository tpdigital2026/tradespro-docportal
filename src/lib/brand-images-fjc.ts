/**
 * FJC's brand images: the ONE place to change them. Files live in public/brands/fjc; every width of the same name on
 * disk (name-800.jpg, name-1400.webp, ...) goes into the srcset automatically.
 *
 * To swap the Home banner (the owner is supplying a wider, shorter export, about 2400x520 with the fades baked in):
 * put hero-<width>.jpg (and .webp) files in public/brands/fjc, change the hero_image line below to the largest jpg and
 * its real size, then run `npm run db:seed` (it updates the stored row). Demo mode reads this list directly. The band
 * height is fixed by CSS (--hero-band-h), so any shape works; a wide, short image is simply cropped least.
 */
export interface BrandImageSeed {
  kind: 'hero_image' | 'sign_in_photo' | 'share_card';
  file: string;
  width: number;
  height: number;
  alt: string;
}

export const FJC_BRAND_IMAGES: readonly BrandImageSeed[] = [
  { kind: 'hero_image', file: 'hero-wide-1400.jpg', width: 1400, height: 304, alt: '' },
  { kind: 'sign_in_photo', file: 'van-1600.jpg', width: 1600, height: 1200, alt: 'FJC Roofing van' },
  { kind: 'share_card', file: 'og.jpg', width: 1200, height: 630, alt: 'FJC Roofing Ltd DocPortal' },
];
