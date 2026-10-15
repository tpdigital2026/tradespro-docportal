/**
 * The one piece of the renderer that cannot run on a Mac: launching the Linux Chromium that @sparticuz/chromium ships,
 * inside a Vercel Function. Everything after launch is engine-puppeteer.ts, which the render tests cover locally.
 *
 * Verified against node_modules/@sparticuz/chromium (build/index.js, helper.js, paths.js) and its README:
 *
 * 1. Versions. @sparticuz/chromium 153.0.0 is Chromium 153. puppeteer-core 25.11.0 is the release whose bundled Chrome
 *    is 153.0.8010.36 (lib/puppeteer/revisions.js), the pairing the README asks for ("visit the Puppeteer Chromium
 *    Support page" and install the matching major). Both are pinned exactly in package.json; bump them together.
 *    Playwright is not used here: playwright-core 1.64 drives Chromium 156 and only supports its own revision.
 *
 * 2. The binary. chromium.executablePath() inflates bin/chromium.br, bin/fonts.tar.br, bin/swiftshader.tar.br and, on
 *    Vercel with Node 20 or later, bin/al2023.tar.br (the shared libraries Amazon Linux 2023 lacks) into os.tmpdir()
 *    (/tmp), then returns /tmp/chromium. A warm instance finds /tmp/chromium and skips the work. The bin folder is
 *    found from the package's own file location (import.meta.url), so the package must stay external
 *    (serverExternalPackages in next.config.ts) and the .br files must be traced into the function, because nothing
 *    imports them (outputFileTracingIncludes; npm run check:render-bundle proves it). Without them the error is
 *    'The input directory ".../@sparticuz/chromium/bin" does not exist'.
 *
 * 3. Environment. Importing @sparticuz/chromium on Vercel (VERCEL set, Node >= 20) runs setupLambdaEnvironment:
 *    FONTCONFIG_PATH=/tmp/fonts and HOME=/tmp unless already set, and /tmp/al2023/lib is prepended to LD_LIBRARY_PATH.
 *    puppeteer passes process.env to the child, so nothing here has to set them. Do not set FONTCONFIG_PATH or
 *    LD_LIBRARY_PATH in the Vercel project: a wrong value there wins.
 *
 * 4. Launch flags. chromium.args already carries --headless='shell', --no-sandbox, --no-zygote, --single-process,
 *    --disable-setuid-sandbox and the GPU flags. The call below is the README's own example: args through
 *    puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }) and headless 'shell' (the binary is
 *    chrome-headless-shell; the "new" headless mode is not built in).
 *
 * 5. Fonts. The documents embed their own fonts as data: URLs, so the Open Sans that fonts.tar.br provides is only a
 *    fallback.
 */
import type { RenderBrowser } from './engine';
import { launchPuppeteer } from './engine-puppeteer';
import { tagStage } from './diagnostics';

export async function launchServerlessChromium(): Promise<RenderBrowser> {
  // Lazy on purpose: the package carries a compressed Chromium and is only wanted on serverless hosts.
  const chromium = (await import('@sparticuz/chromium')).default;
  const puppeteer = (await import('puppeteer-core')).default;

  let executablePath: string;
  try {
    executablePath = await chromium.executablePath();
  } catch (e) {
    throw tagStage(e, 'extract');
  }
  const args = await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' });
  return launchPuppeteer({ args, executablePath, headless: 'shell' });
}
