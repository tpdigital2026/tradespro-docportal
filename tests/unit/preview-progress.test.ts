import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(__dirname, '../../src/styles/app.css'), 'utf8');
const preview = readFileSync(path.join(__dirname, '../../src/app/(app)/documents/[id]/Preview.tsx'), 'utf8');
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1);
};

describe('preview reading progress bar', () => {
  it('animates only a transform (scaleX from the left), never width', () => {
    const r = rule('.pv-progress-bar span');
    expect(r).toMatch(/transform: scaleX\(var\(--pv-read, 0\)\)/);
    expect(r).toMatch(/transform-origin: left/);
    expect(r).toMatch(/transition: transform /);
    expect(r).not.toMatch(/transition:[^;]*width/);
  });
  it('the component sets the --pv-read ratio (clamped 0 to 1), not an inline width', () => {
    expect(preview).toMatch(/'--pv-read': String\(pageCount > 0 \? Math\.min\(1, Math\.max\(0, read \/ pageCount\)\) : 0\)/);
    expect(preview).not.toMatch(/style=\{\{ width: `\$\{\(read/);
  });
  it('keeps the reduced-motion rule: no transition', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.pv-progress-bar span \{ transition: none; \} \}/);
  });
});
