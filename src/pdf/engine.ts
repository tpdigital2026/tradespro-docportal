/**
 * The renderer seam: the few browser operations the document pipeline needs, behind one small interface with two
 * implementations.
 *
 *  - playwright (engine-playwright.ts): local development and the render tests. playwright-core is only supported
 *    against its own Chromium revision, which is fine for a locally installed Chrome but not for the serverless binary.
 *  - puppeteer (engine-puppeteer.ts): puppeteer-core, pinned to the version whose Chrome matches @sparticuz/chromium
 *    (see README "Rendering on Vercel"). This is the engine on Vercel. It also runs locally against an installed Chrome,
 *    so the whole render test suite is run under both engines (npm run test:render:puppeteer).
 *
 * src/pdf/*, src/templates/* and the render service only ever see RenderBrowser and RenderPage.
 */

export type RenderEngine = 'playwright' | 'puppeteer';
export type RenderRuntime = 'local' | 'serverless';

type Env = Record<string, string | undefined>;

/**
 * Where the browser comes from. serverless: the @sparticuz/chromium binary (Linux only). local: an installed Chrome at
 * CHROMIUM_PATH, or the macOS default path. RENDER_RUNTIME wins; otherwise Vercel means serverless.
 */
export function renderRuntime(env: Env = process.env): RenderRuntime {
  const explicit = env.RENDER_RUNTIME?.trim().toLowerCase();
  if (explicit === 'serverless' || explicit === 'local') return explicit;
  return env.VERCEL ? 'serverless' : 'local';
}

/**
 * Which library drives the browser. The serverless runtime is always puppeteer (the only supported pairing with
 * @sparticuz/chromium). Locally RENDER_ENGINE picks; the default is playwright.
 */
export function renderEngine(env: Env = process.env): RenderEngine {
  if (renderRuntime(env) === 'serverless') return 'puppeteer';
  const explicit = env.RENDER_ENGINE?.trim().toLowerCase();
  return explicit === 'puppeteer' ? 'puppeteer' : 'playwright';
}

export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Page geometry every render uses: A4 at 96 dpi, drawn at twice the pixel density for crisp page images. */
export const VIEWPORT = { width: 794, height: 1123, deviceScaleFactor: 2 } as const;

export interface RenderPage {
  /** Replaces the page's document and waits for its load event. */
  setContent(html: string): Promise<void>;
  /** Lays the page out for print (the @page rules and print styles apply). */
  emulatePrint(): Promise<void>;
  /** Runs fn in the page with one serialisable argument and returns its serialisable result. */
  evaluate<R>(fn: () => R | Promise<R>): Promise<Awaited<R>>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<Awaited<R>>;
  /** Runs fn in the page over every element matching selector. */
  $$eval<R>(selector: string, fn: (els: Element[]) => R | Promise<R>): Promise<Awaited<R>>;
  $$eval<R, A>(selector: string, fn: (els: Element[], arg: A) => R | Promise<R>, arg: A): Promise<Awaited<R>>;
  /** Runs fn in the page over the first element matching selector; throws when there is none. */
  $eval<R>(selector: string, fn: (el: Element) => R | Promise<R>): Promise<Awaited<R>>;
  /** Resolves once fn returns a truthy value in the page. */
  waitForFunction(fn: () => unknown): Promise<void>;
  /** A4 PDF honouring the document's @page size, with backgrounds. */
  pdf(): Promise<Buffer>;
  /** One PNG per element matching selector, in document order. */
  screenshotAll(selector: string): Promise<Buffer[]>;
  /** Calls listener with the URL of each request that failed (the network lock aborts every non-data request). */
  onRequestFailed(listener: (url: string) => void): () => void;
  /** Closes the page and anything created for it. Never throws. */
  close(): Promise<void>;
}

export interface RenderBrowser {
  readonly engine: RenderEngine;
  /** A page that cannot reach the network. data: URLs still load, so embedded fonts and images work. */
  newLockedPage(): Promise<RenderPage>;
  /** A page WITHOUT the network lock. Tests only (proves each layer of the lock on its own). Never use for documents. */
  newUnlockedPageForTests(): Promise<RenderPage>;
  isConnected(): boolean;
  close(): Promise<void>;
}
