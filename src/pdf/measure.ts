import { raw, type Raw } from '../lib/html';
import { inStage } from './diagnostics';
import { documentShell } from './document';
import type { RenderPage } from './engine';

export const PX_PER_MM = 96 / 25.4;

/** Height in CSS pixels of each fragment when laid out at the given width, margins included. */
export async function measureFragments(page: RenderPage, css: string, widthMm: number, fragments: Raw[]): Promise<number[]> {
  const inner = fragments.map((f) => `<div data-m style="display:flow-root">${f.value}</div>`).join('');
  const doc = documentShell({ title: 'measure', css, body: raw(`<div style="width:${widthMm}mm">${inner}</div>`) });
  return inStage('layout', async () => {
    await page.setContent(doc);
    await page.emulatePrint();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    return page.$$eval('[data-m]', (els) => els.map((e) => e.getBoundingClientRect().height));
  });
}
