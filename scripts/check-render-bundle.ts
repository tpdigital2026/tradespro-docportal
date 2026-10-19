/**
 * npm run check:render-bundle
 *
 * Builds the app (unless --no-build) and proves, from Next's own trace files (.next/server/**\/*.nft.json), that every
 * route that renders carries what it reads from disk at run time on Vercel:
 *  - the compressed serverless Chromium (@sparticuz/chromium/bin/*.br) and the packages that launch it;
 *  - the document stylesheet, the self-hosted fonts and the brand images (document routes).
 * These files are found by path at run time, not imported, so a missing outputFileTracingIncludes entry only shows up
 * as a failed render on the deployment. This check makes it fail the build instead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface RouteExpectation {
  /** The trace file, relative to .next/server. */
  nft: string;
  /** Repository-relative files that must appear in it. A trailing / or * means "at least one path starting with this". */
  required: string[];
}

const CHROMIUM = [
  'node_modules/@sparticuz/chromium/bin/chromium.br',
  'node_modules/@sparticuz/chromium/bin/al2023.tar.br',
  'node_modules/@sparticuz/chromium/bin/fonts.tar.br',
  'node_modules/@sparticuz/chromium/bin/swiftshader.tar.br',
  'node_modules/@sparticuz/chromium/build/index.js',
  'node_modules/@sparticuz/chromium/build/lambdafs.js',
  'node_modules/tar-fs/',
  'node_modules/tar-stream/',
  'node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',
  'node_modules/@puppeteer/browsers/',
  'node_modules/ws/',
  // Turbopack loads external packages through hashed links in .next/node_modules; the links must be traced too.
  '.next/node_modules/@sparticuz/chromium-*',
  '.next/node_modules/puppeteer-core-*',
  // chromium-bidi is not required: it is only loaded for the WebDriver BiDi protocol, and the launch pins protocol 'cdp'.
];

// The fonts src/pdf/assets.ts embeds (FONTS), and the stylesheet src/themes/theme.ts reads.
const FONT_FILES = [
  ...[500, 600, 700].map((w) => `node_modules/@fontsource/playfair-display/files/playfair-display-latin-${w}-normal.woff2`),
  ...[400, 500, 600, 700].map((w) => `node_modules/@fontsource/inter/files/inter-latin-${w}-normal.woff2`),
  ...[400, 500].map((w) => `node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${w}-normal.woff2`),
];
// The locked templates' images (src/templates/library, checked by hash at render time).
const DOCUMENT_ASSETS = ['src/themes/fjc/base.css', ...FONT_FILES, 'public/brands/fjc/', 'src/templates/library/fjc/quotation-flat-roof/cover.jpg', 'src/templates/library/fjc/brand/logo.png'];

export const RENDER_ROUTES: RouteExpectation[] = [
  { nft: 'app/(app)/documents/[id]/preview/page.js.nft.json', required: [...CHROMIUM, ...DOCUMENT_ASSETS] },
  { nft: 'app/(app)/documents/[id]/page.js.nft.json', required: [...CHROMIUM, ...DOCUMENT_ASSETS] },
  { nft: 'app/api/documents/[id]/finalise/route.js.nft.json', required: [...CHROMIUM, ...DOCUMENT_ASSETS] },
  { nft: 'app/api/settings/signature/route.js.nft.json', required: CHROMIUM },
];

/** Returns the problems found for one route, given the repository-relative files its trace lists. Pure. */
export function missingFiles(traced: readonly string[], required: readonly string[]): string[] {
  const set = new Set(traced);
  return required.filter((r) => {
    if (r.endsWith('/') || r.endsWith('*')) {
      const prefix = r.endsWith('*') ? r.slice(0, -1) : r;
      return !traced.some((t) => t.startsWith(prefix));
    }
    return !set.has(r);
  });
}

/** Reads one .nft.json and returns its files relative to the repository root, with forward slashes. */
export function tracedFiles(root: string, nftPath: string): string[] {
  const { files } = JSON.parse(readFileSync(nftPath, 'utf8')) as { files: string[] };
  const dir = path.dirname(nftPath);
  return files.map((f) => path.relative(root, path.resolve(dir, f)).split(path.sep).join('/'));
}

export function checkRenderBundle(root: string, routes: RouteExpectation[] = RENDER_ROUTES): string[] {
  const problems: string[] = [];
  for (const r of routes) {
    const nftPath = path.join(root, '.next', 'server', r.nft);
    if (!existsSync(nftPath)) {
      problems.push(`${r.nft}: trace file not found (did the route move?)`);
      continue;
    }
    for (const m of missingFiles(tracedFiles(root, nftPath), r.required)) problems.push(`${r.nft}: missing ${m}`);
  }
  return problems;
}

function main(): void {
  const root = process.cwd();
  if (!process.argv.includes('--no-build')) {
    execFileSync(process.execPath, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], { stdio: 'inherit', cwd: root });
  }
  const problems = checkRenderBundle(root);
  if (problems.length > 0) {
    console.error(`Render bundle check failed (${problems.length}):\n  ${problems.join('\n  ')}`);
    console.error('Fix outputFileTracingIncludes / serverExternalPackages in next.config.ts.');
    process.exit(1);
  }
  console.log(`Render bundle check passed: ${RENDER_ROUTES.length} routes carry Chromium, fonts, stylesheet and brand files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
