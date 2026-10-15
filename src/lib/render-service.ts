/**
 * The render service seam: a stored document version in, its PDF and one PNG per page out.
 *
 *   renderDocument(versionId, who) -> { pdf, pngPages }
 *
 * The browser comes from an adapter chosen by the environment:
 *  - local (default): playwright-core with Chrome at CHROMIUM_PATH, or the macOS default path;
 *  - serverless (RENDER_RUNTIME=serverless, or on Vercel): @sparticuz/chromium launched through playwright-core.
 *    It is imported lazily, so builds and local runs never need it.
 *
 * Everything that decides what a document says lives in src/lib/documents/map.ts (pure); facts are loaded in
 * src/lib/data/documents.ts. This module only lays out and prints.
 */
import 'server-only';
import type { Browser } from 'playwright-core';
import { newLockedPage, launchBrowser } from '../pdf/browser';
import { renderPdf } from '../pdf/render';
import { buildBalanceInvoice, buildDepositInvoice, buildFullInvoice, buildStageInvoice } from '../templates/invoice';
import { buildQuotation } from '../templates/quotation';
import { buildReceipt } from '../templates/receipt';
import type { Brand, Tenant } from '../themes/types';
import type { Mapped } from './documents/map';
import { SIGNATURE_OUT_H, SIGNATURE_OUT_W, stripPng, type Reencoded, type Sniffed } from './signature-image';

export interface RenderOutput {
  pdf: Buffer;
  pngPages: Buffer[];
}

export type RenderRuntime = 'local' | 'serverless';

export function renderRuntime(env: Record<string, string | undefined> = process.env): RenderRuntime {
  const explicit = env.RENDER_RUNTIME?.trim().toLowerCase();
  if (explicit === 'serverless' || explicit === 'local') return explicit;
  return env.VERCEL ? 'serverless' : 'local';
}

async function launchServerless(): Promise<Browser> {
  // Lazy on purpose: the package carries a compressed Chromium and is only wanted on serverless hosts.
  const chromium = (await import('@sparticuz/chromium')).default;
  const { chromium: pw } = await import('playwright-core');
  return pw.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
}

let shared: Promise<Browser> | null = null;

/** One browser per server process, relaunched if it has gone away. Serverless instances each get their own. */
async function browser(): Promise<Browser> {
  if (shared) {
    const b = await shared.catch(() => null);
    if (b && b.isConnected()) return b;
    shared = null;
  }
  shared = renderRuntime() === 'serverless' ? launchServerless() : launchBrowser();
  return shared;
}

/** Lays out one mapped document and prints it. A layout that overflows a page throws (PageOverflowError). */
export async function renderMapped(mapped: Mapped, tenant: Tenant, brand: Brand, open: () => Promise<Browser> = browser): Promise<RenderOutput> {
  const b = await open();
  const page = await newLockedPage(b);
  try {
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
    }
    const pdf = await renderPdf(page, docHtml);
    const pngPages: Buffer[] = [];
    for (const el of await page.$$('.page')) pngPages.push(await el.screenshot({ type: 'png' }));
    return { pdf, pngPages };
  } finally {
    await page.context().close().catch(() => undefined);
  }
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
export async function reencodeSignature(bytes: Buffer, image: Sniffed, open: () => Promise<Browser> = browser): Promise<Reencoded> {
  const b = await open();
  const page = await newLockedPage(b);
  try {
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
  } finally {
    await page.context().close().catch(() => undefined);
  }
}

/** Test hook and graceful shutdown. */
export async function closeRenderBrowser(): Promise<void> {
  const b = shared ? await shared.catch(() => null) : null;
  shared = null;
  await b?.close().catch(() => undefined);
}
