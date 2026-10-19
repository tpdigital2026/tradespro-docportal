/**
 * Real-Chrome check that Home's Jobs table (the one main object) starts above the fold, with its first row visible,
 * and that nothing scrolls sideways.
 * Run against a demo dev server: `DEMO_MODE=1 next dev -p 3464`, then `npm run check:home-fold -- http://localhost:3464`.
 * Exits 1 on any failure.
 */
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://localhost:3464';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZES: [number, number][] = [[390, 844], [768, 1024], [1440, 900], [1280, 720], [1920, 1080]];

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
        const table = r('#jobs'), row = r('.jobs-table tbody tr, .jobs-empty');
        const d = document.documentElement;
        return { tableTop: table ? table.top : null, rowBottom: row ? row.bottom : null, sideways: d.scrollWidth > d.clientWidth };
      })()`)) as { tableTop: number | null; rowBottom: number | null; sideways: boolean };
      const line = `${width}x${height}: Jobs starts at ${Math.round(m.tableTop ?? -1)}px, first row ends at ${Math.round(m.rowBottom ?? -1)}px`;
      console.log(line);
      if (m.tableTop === null || m.rowBottom === null || m.rowBottom > height) failures.push(`${line}: first job row below the fold`);
      if (m.sideways) failures.push(`${line}: page scrolls sideways`);
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
