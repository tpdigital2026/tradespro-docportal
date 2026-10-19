import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export function dataUri(filePath: string): string {
  const mime = MIME[path.extname(filePath).toLowerCase()];
  if (!mime) throw new Error(`Unsupported asset type: ${filePath}`);
  return `data:${mime};base64,${readFileSync(filePath).toString('base64')}`;
}

const uriCache = new Map<string, { stamp: string; uri: string }>();

/**
 * dataUri, kept in memory per file (checked against its size and modification time), so brand pictures are read and
 * encoded once per server process rather than on every preview.
 */
export function cachedDataUri(filePath: string): string {
  const st = statSync(filePath);
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = uriCache.get(filePath);
  if (hit && hit.stamp === stamp) return hit.uri;
  const uri = dataUri(filePath);
  if (uriCache.size > 64) uriCache.clear();
  uriCache.set(filePath, { stamp, uri });
  return uri;
}

const FONTS = [
  { family: 'Playfair', pkg: 'playfair-display', weights: [500, 600, 700] },
  { family: 'Inter', pkg: 'inter', weights: [400, 500, 600, 700] },
  { family: 'Mono', pkg: 'jetbrains-mono', weights: [400, 500] },
];

let cached: string | undefined;

export function fontFaceCss(): string {
  if (cached) return cached;
  const rules: string[] = [];
  for (const f of FONTS) {
    for (const w of f.weights) {
      const file = path.join(process.cwd(), 'node_modules', '@fontsource', f.pkg, 'files', `${f.pkg}-latin-${w}-normal.woff2`);
      rules.push(`@font-face{font-family:"${f.family}";src:url(${dataUri(file)}) format("woff2");font-weight:${w}}`);
    }
  }
  cached = rules.join('\n');
  return cached;
}
