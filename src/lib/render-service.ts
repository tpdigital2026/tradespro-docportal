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
import { buildSurvey } from '../templates/survey';
import type { Brand, Tenant } from '../themes/types';
import type { Mapped } from './documents/map';

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
      case 'survey': {
        const { resolveSurveyPhotos } = await import('./survey/render');
        const { getStorage } = await import('./storage');
        docHtml = await buildSurvey(page, await resolveSurveyPhotos(mapped.input, getStorage()), tenant, brand);
        break;
      }
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

/** Test hook and graceful shutdown. */
export async function closeRenderBrowser(): Promise<void> {
  const b = shared ? await shared.catch(() => null) : null;
  shared = null;
  await b?.close().catch(() => undefined);
}
