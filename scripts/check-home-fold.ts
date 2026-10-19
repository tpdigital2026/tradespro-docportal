/**
 * Real-Chrome check that Home's document tiles start above the fold and the banner headline fits its band.
 * Run against a demo dev server: `DEMO_MODE=1 next dev -p 3464`, then `npm run check:home-fold -- http://localhost:3464`.
 * Exits 1 on any failure.
 */
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://localhost:3464';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZES: [number, number][] = [[1440, 900], [1280, 720], [1920, 1080]];

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME });
  const failures: string[] = [];
  try {
    for (const [width, height] of SIZES) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      // A string, not a function: tsx would add helpers the page does not have.
      const m = (await page.evaluate(`(() => {
        const r = (s) => { const el = document.querySelector(s); return el ? el.getBoundingClientRect() : null; };
        const tiles = r('.tiles'), hero = r('.hero'), h1 = r('.hero-h'), hello = r('.hero-hello');
        return { tilesTop: tiles ? tiles.top : null, heroH: hero ? hero.height : null, heroBottom: hero ? hero.bottom : null, h1Bottom: h1 ? h1.bottom : null, helloTop: hello ? hello.top : null };
      })()`)) as { tilesTop: number | null; heroH: number | null; heroBottom: number | null; h1Bottom: number | null; helloTop: number | null };
      const line = `${width}x${height}: hero ${Math.round(m.heroH ?? -1)}px, tiles start at ${Math.round(m.tilesTop ?? -1)}px`;
      console.log(line);
      if (m.tilesTop === null || m.tilesTop >= height) failures.push(`${line}: tiles below the fold`);
      if (m.heroBottom !== null && m.h1Bottom !== null && (m.h1Bottom > m.heroBottom || (m.helloTop ?? 0) < 0)) failures.push(`${line}: headline does not fit the band`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('Home fold check passed.');
}

main();
