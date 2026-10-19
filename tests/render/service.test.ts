import { afterAll, describe, expect, it } from 'vitest';
import { closeRenderBrowser, renderMapped, sharedRenderBrowserForTests } from '../../src/lib/render-service';
import { stageOf } from '../../src/pdf/diagnostics';
import { renderEngine } from '../../src/pdf/engine';
import { PageOverflowError } from '../../src/pdf/render';
import { fakeBrand, fakeTenant } from '../fixtures/fake';
import { guaranteeFixture } from '../fixtures/guarantee';
import { depositReceiptFixture } from '../fixtures/receipts';

afterAll(() => closeRenderBrowser());

const pdfPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
const isPng = (b: Buffer) => b.subarray(1, 4).toString('latin1') === 'PNG';

describe(`render service (${renderEngine()})`, () => {
  it('returns a PDF and one PNG per page through the shared browser', async () => {
    const out = await renderMapped({ kind: 'receipt', input: depositReceiptFixture }, fakeTenant, fakeBrand);
    expect(out.pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(out.pngPages).toHaveLength(pdfPages(out.pdf));
    expect(out.pngPages.every(isPng)).toBe(true);
    expect((await sharedRenderBrowserForTests())?.engine).toBe(renderEngine());
  });

  it('renders a guarantee certificate as one page through the service', async () => {
    const out = await renderMapped({ kind: 'guarantee', input: guaranteeFixture }, fakeTenant, fakeBrand);
    expect(out.pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdfPages(out.pdf)).toBe(1);
    expect(out.pngPages).toHaveLength(1);
    expect(out.pngPages.every(isPng)).toBe(true);
  });

  it('relaunches once when the shared browser has died (a crashed browser on a warm instance)', async () => {
    const before = await sharedRenderBrowserForTests();
    expect(before).not.toBeNull();
    await before!.close();
    expect(before!.isConnected()).toBe(false);
    const out = await renderMapped({ kind: 'receipt', input: depositReceiptFixture }, fakeTenant, fakeBrand);
    expect(out.pngPages.length).toBeGreaterThan(0);
    const after = await sharedRenderBrowserForTests();
    expect(after).not.toBe(before);
    expect(after?.isConnected()).toBe(true);
  });

  it('tags a failure with its stage and does not retry a layout error', async () => {
    const huge = { ...depositReceiptFixture, description: 'Very long description '.repeat(400) };
    const err = await renderMapped({ kind: 'receipt', input: huge }, fakeTenant, fakeBrand).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PageOverflowError);
    expect(stageOf(err)).toBe('check');
    expect((await sharedRenderBrowserForTests())?.isConnected()).toBe(true);
  });

  it('tags a browser that cannot start as a launch failure', async () => {
    const err = await renderMapped({ kind: 'receipt', input: depositReceiptFixture }, fakeTenant, fakeBrand, async () => {
      const { launchBrowser } = await import('../../src/pdf/browser');
      const saved = process.env.CHROMIUM_PATH;
      process.env.CHROMIUM_PATH = '/nonexistent/chrome';
      try {
        return await launchBrowser();
      } finally {
        if (saved === undefined) delete process.env.CHROMIUM_PATH;
        else process.env.CHROMIUM_PATH = saved;
      }
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(stageOf(err)).toBe('launch');
  });
});
