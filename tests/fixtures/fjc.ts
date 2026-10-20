import { existsSync } from 'node:fs';
import path from 'node:path';
import { dataUri } from '../../src/pdf/assets';
import type { Brand, Tenant } from '../../src/themes/types';
import { greyPng } from './png';

export const REFERENCE_ASSETS = path.join(
  process.cwd(),
  'reference',
  'DocPortal_Reference',
  '1_FJC_Roofing',
  'brand_assets',
);

export const referenceAvailable = existsSync(REFERENCE_ASSETS);

export const fjcTenant: Tenant = {
  name: 'FJC Roofing Ltd',
  addressLine: 'Rochester · United Kingdom · ME3 9UD',
  phone: '07596115834',
  email: 'Ben@fjcroofingltd.com',
  web: 'www.fjcroofingltd.co.uk',
  companyNo: '13855379',
  vatNo: 'GB 408094403',
  tagline: 'Covering Your Home, Protecting Your Family',
  ownerName: 'Ben Cunningham',
  ownerTitle: 'Director',
};

export const fjcColours = {
  navy: '#0f2b4a',
  navy2: '#16395f',
  navy3: '#1f4a78',
  blue: '#2f6fbf',
  sky: '#7fa6dc',
  ice: '#e9f0f9',
  gold: '#c9a24b',
  gold2: '#e4cf9a',
  goldbg: '#faf5e8',
  ink: '#152235',
  body: '#3a4657',
  muted: '#6b7686',
  rule: '#dde3eb',
  paper: '#f4f6fa',
};

/** FJC's committed files: the brand logos, and the flat roof quotation template's photo and diagram (src/templates/library/fjc). */
export const FJC_PUBLIC = path.join(process.cwd(), 'public', 'brands', 'fjc');
const FLAT_TEMPLATE = path.join(process.cwd(), 'src', 'templates', 'library', 'fjc', 'quotation-flat-roof');

/**
 * A stand-in for a stored signature: a plain grey strip the size of the owner's. His real signature is never committed;
 * the templates print whatever picture is stored, so this proves the line is filled.
 */
export const STAND_IN_SIGNATURE = `data:image/png;base64,${greyPng(526, 114, 90).toString('base64')}`;

/** The FJC brand from committed files only (so these render tests run on any checkout), for the plain layout's tests. */
export function loadFjcBrand(): Brand {
  const f = (name: string) => dataUri(path.join(FJC_PUBLIC, name));
  return {
    colours: fjcColours,
    assets: {
      logoColour: f('logo.png'),
      logoWhite: f('logo_white.png'),
      signature: STAND_IN_SIGNATURE,
      coverPhoto: dataUri(path.join(FLAT_TEMPLATE, 'cover.jpg')),
      diagram: dataUri(path.join(FLAT_TEMPLATE, 'diagram-flat.jpg')),
    },
  };
}
