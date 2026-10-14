import { existsSync } from 'node:fs';
import path from 'node:path';
import { dataUri } from '../../src/pdf/assets';
import type { Brand, Tenant } from '../../src/themes/types';

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

export function loadFjcBrand(): Brand {
  const f = (name: string) => dataUri(path.join(REFERENCE_ASSETS, name));
  return {
    colours: fjcColours,
    assets: {
      logoColour: f('logo.png'),
      logoWhite: f('logo_white.png'),
      signature: f('sig_rgba.png'),
      coverPhoto: f('ph_flat.jpg'),
      diagram: f('diag_flat.jpg'),
    },
  };
}
