import type { Brand, Tenant } from '../../src/themes/types';
import { fjcColours, fjcTenant } from './fjc';

// A valid 1x1 PNG so render tests run on any checkout without the reference assets.
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const fakeTenant: Tenant = { ...fjcTenant };

export const fakeBrand: Brand = {
  colours: fjcColours,
  assets: { logoColour: PIXEL, logoWhite: PIXEL, signature: PIXEL, coverPhoto: PIXEL, diagram: PIXEL },
};
