import { fontFaceCss } from '../pdf/assets';
import { loadBaseCss, themeVarsCss } from '../themes/theme';
import type { Brand } from '../themes/types';

export function documentCss(brand: Brand): string {
  return [fontFaceCss(), loadBaseCss(), themeVarsCss(brand.colours)].join('\n');
}
