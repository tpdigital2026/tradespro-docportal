/**
 * The render service seam: a stored document version in, its PDF and one PNG per page out.
 *
 *   renderDocument(versionId, who) -> { pdf, pngPages }
 *
 * The browser comes from src/pdf/browser.ts, chosen by the environment (src/pdf/engine.ts):
 *  - local (default): Chrome at CHROMIUM_PATH, or the macOS default path, driven by playwright-core
 *    (or puppeteer-core with RENDER_ENGINE=puppeteer);
 *  - serverless (RENDER_RUNTIME=serverless, or on Vercel): puppeteer-core with @sparticuz/chromium
 *    (src/pdf/serverless-chromium.ts), imported lazily, so builds and local runs never load it.
 *
 * Failures are tagged with the stage they happened in and logged by the callers with logRenderFailure
 * (src/pdf/diagnostics.ts): stage, error class and code, never document content.
 *
 * Everything that decides what a document says lives in src/lib/documents/map.ts (pure); facts are loaded in
 * src/lib/data/documents.ts. This module only lays out and prints.
 */
import 'server-only';
import { launchBrowser, newLockedPage, type RenderBrowser, type RenderPage } from '../pdf/browser';
import { inStage, logRenderOk } from '../pdf/diagnostics';
import { renderRuntime } from '../pdf/engine';
import { renderPdf, screenshotEachPage } from '../pdf/render';
import { buildBalanceInvoice, buildDepositInvoice, buildFullInvoice, buildStageInvoice } from '../templates/invoice';
import { buildQuotation } from '../templates/quotation';
import { buildReceipt } from '../templates/receipt';
import { buildSurvey } from '../templates/survey';
import type { Brand, Tenant } from '../themes/types';
import type { Mapped } from './documents/map';
import { SIGNATURE_OUT_H, SIGNATURE_OUT_W, stripPng, type Reencoded, type Sniffed } from './signature-image';

export { renderRuntime, type RenderRuntime } from '../pdf/engine';

export interface RenderOutput {
  pdf: Buffer;
  pngPages: Buffer[];
}

let shared: Promise<RenderBrowser> | null = null;

/** One browser per server process, relaunched if it has gone away. Serverless instances each get their own. */
async function browser(): Promise<RenderBrowser> {
  if (shared) {
    const b = await shared.catch(() => null);
    if (b && b.isConnected()) return b;
    shared = null;
  }
  const launching = launchBrowser();
  shared = launching;
  launching.catch(() => {
    if (shared === launching) shared = null;
  });
  return launching;
}

/**
 * On serverless, renders in one instance run one at a time. The serverless Chromium runs with --single-process, so a
 * crash in one page takes the whole browser down; Vercel's in-function concurrency could otherwise put two renders
 * into that one process. Locally renders run side by side as before.
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  if (renderRuntime() !== 'serverless') return fn();
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Opens a locked page on the shared browser and runs fn with it. If the browser died under us (a crashed
 * single-process Chromium on a warm instance, or a page that could not be opened), it is relaunched once and fn runs
 * again. Layout errors such as PageOverflowError are never retried: the browser is still connected after those.
 */
async function withPage<T>(open: () => Promise<RenderBrowser>, fn: (page: RenderPage) => Promise<T>, timings?: Record<string, number>): Promise<T> {
  const attempt = async (): Promise<T> => {
    const t0 = Date.now();
    const b = await open();
    if (timings) timings.launch = Date.now() - t0;
    const page = await newLockedPage(b);
    try {
      return await fn(page);
    } finally {
      await page.close();
    }
  };
  try {
    return await attempt();
  } catch (e) {
    const b = open === browser && shared ? await shared.catch(() => null) : null;
    if (open !== browser || !b || b.isConnected()) throw e;
    shared = null;
    await b.close().catch(() => undefined);
    return attempt();
  }
}

/** Lays out one mapped document and prints it. A layout that overflows a page throws (PageOverflowError). */
export function renderMapped(mapped: Mapped, tenant: Tenant, brand: Brand, open: () => Promise<RenderBrowser> = browser): Promise<RenderOutput> {
  const cold = shared === null;
  const ms: Record<string, number> = {};
  return serial(() =>
    withPage(
      open,
      async (page) => {
        let t = Date.now();
        let docHtml: string;
        switch (mapped.kind) {
          case 'quotation':
            docHtml = await buildQuotation(page, mapped.input, tenant, brand);
            break;
          case 'deposit-invoice':
            docHtml = await buildDepositInvoice(page, mapped.input, tenant, brand);
            break;
          case 'balance-invoice':
            docHtml = await buildBalanceInvoice(page, mapped.input, tenant, brand);
            break;
          case 'invoice-full':
            docHtml = await buildFullInvoice(page, mapped.input, tenant, brand);
            break;
          case 'invoice-stage':
            docHtml = await buildStageInvoice(page, mapped.input, tenant, brand);
            break;
          case 'receipt':
            docHtml = buildReceipt(mapped.input, tenant, brand);
            break;
          case 'survey': {
            const { resolveSurveyPhotos } = await import('./survey/render');
            const { getStorage } = await import('./storage');
            docHtml = await buildSurvey(page, await resolveSurveyPhotos(mapped.input, getStorage()), tenant, brand);
            break;
          }
        }
        ms.build = Date.now() - t;
        t = Date.now();
        const pdf = await renderPdf(page, docHtml);
        ms.pdf = Date.now() - t;
        t = Date.now();
        const pngPages = await screenshotEachPage(page);
        ms.screenshot = Date.now() - t;
        logRenderOk('document', { cold, ms, pages: pngPages.length });
        return { pdf, pngPages };
      },
      ms,
    ),
  );
}

/** The seam the screens and the finalise route use. Facts are loaded for the signed-in business only. */
export async function renderDocument(versionId: string, who: { tenantId: string }): Promise<RenderOutput> {
  const { prepareVersion } = await import('./data/documents');
  const prepared = await prepareVersion(who.tenantId, versionId);
  if (!prepared.ok) throw new MissingFactsError(prepared.missing);
  return renderMapped(prepared.mapped, prepared.tenant, prepared.brand);
}

export class MissingFactsError extends Error {
  constructor(readonly missing: string[]) {
    super('Some facts this document needs are missing');
    this.name = 'MissingFactsError';
  }
}

/**
 * Decodes an uploaded signature picture in a page with no network access and draws it again on a fresh canvas, as a
 * PNG at most 1200 by 400 (never enlarged). Only pixels survive: no EXIF, GPS, XMP, ICC profile or comments. Near-white
 * paper becomes transparent, so the signature sits on the document's sign line instead of in a white box. The result
 * is then cut down to its essential PNG chunks (stripPng).
 */
export function reencodeSignature(bytes: Buffer, image: Sniffed, open: () => Promise<RenderBrowser> = browser): Promise<Reencoded> {
  return serial(() => withPage(open, (page) => inStage('decode', () => decodeAndRedraw(page, bytes, image))));
}

async function decodeAndRedraw(page: RenderPage, bytes: Buffer, image: Sniffed): Promise<Reencoded> {
  const src = `data:image/${image.kind};base64,${bytes.toString('base64')}`;
  // The size is worked out in the page from naturalWidth/naturalHeight AFTER decoding, because a phone photo's EXIF
  // orientation can turn a landscape-coded picture upright; the header's width and height would squash it.
  const out = await page.evaluate(
    async ({ src, maxW, maxH }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const w0 = img.naturalWidth;
      const h0 = img.naturalHeight;
      if (!w0 || !h0) throw new Error('Empty picture');
      const scale = Math.min(1, maxW / w0, maxH / h0);
      const width = Math.max(1, Math.round(w0 * scale));
      const height = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No canvas');
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        // Paper white fades out; ink keeps its colour. A soft edge between 200 and 240 avoids jagged strokes.
        const keep = lum >= 240 ? 0 : lum <= 200 ? 1 : (240 - lum) / 40;
        px[i + 3] = Math.round(px[i + 3] * keep);
      }
      ctx.putImageData(data, 0, 0);
      return { url: canvas.toDataURL('image/png'), width, height };
    },
    { src, maxW: SIGNATURE_OUT_W, maxH: SIGNATURE_OUT_H },
  );
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(out.url);
  if (!m) throw new Error('The picture could not be read');
  const size = { width: out.width, height: out.height };
  return { png: stripPng(Buffer.from(m[1], 'base64')), ...size };
}

/** Test hook and graceful shutdown. */
export async function closeRenderBrowser(): Promise<void> {
  const b = shared ? await shared.catch(() => null) : null;
  shared = null;
  await b?.close().catch(() => undefined);
}

/** Test hook: the shared browser, if one is running (used to simulate a crashed browser on a warm instance). */
export async function sharedRenderBrowserForTests(): Promise<RenderBrowser | null> {
  return shared ? shared.catch(() => null) : null;
}
