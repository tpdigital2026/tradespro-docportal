import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pageFile, previewFolder, versionFolder } from '../../src/lib/documents/finalise';
import { photoPath } from '../../src/lib/data/surveys';
import { signaturePath } from '../../src/lib/data/settings';
import { classify, SWEEP_SHAPES, type References } from '../../src/lib/maintenance/orphan-sweep';

const T = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const J = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const R = '55555555-5555-4555-8555-555555555555';
const P = '66666666-6666-4666-8666-666666666666';
const S = '77777777-7777-4777-8777-777777777777';
const none = (): References => ({ paths: new Set(), folders: new Set(), draftVersions: new Set() });
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);

/**
 * Every kind of file the app stores, built with the app's own path builders, and how the database records it.
 * A new kind of stored file must be added here AND to the sweep (shape + reference query), or this test fails below.
 */
const folder = versionFolder(T, { customerId: C, jobId: J }, V);
const KNOWN: { name: string; path: string; shape: keyof typeof SWEEP_SHAPES; recorded: (p: string) => References }[] = [
  { name: 'finalised PDF (request folder)', path: `${folder}/${R}/document.pdf`, shape: 'finaliseRequestFile', recorded: (p) => ({ ...none(), folders: new Set([dirOf(p)]) }) },
  { name: 'finalised page image (request folder)', path: `${folder}/${R}/${pageFile(3)}`, shape: 'finaliseRequestFile', recorded: (p) => ({ ...none(), folders: new Set([dirOf(p)]) }) },
  { name: 'older per-version PDF', path: `${folder}/document.pdf`, shape: 'versionFile', recorded: (p) => ({ ...none(), paths: new Set([p]), folders: new Set([dirOf(p)]) }) },
  { name: 'older per-version page image', path: `${folder}/${pageFile(1)}`, shape: 'versionFile', recorded: (p) => ({ ...none(), folders: new Set([dirOf(p)]) }) },
  { name: 'draft preview page', path: `${previewFolder(folder, 'k_ey-1')}/${pageFile(2)}`, shape: 'previewFile', recorded: () => ({ ...none(), draftVersions: new Set([V]) }) },
  { name: 'draft preview manifest', path: `${previewFolder(folder, 'k_ey-1')}/pages.json`, shape: 'previewFile', recorded: () => ({ ...none(), draftVersions: new Set([V]) }) },
  { name: 'survey / job photo', path: photoPath(T, C, J, P), shape: 'jobPhoto', recorded: (p) => ({ ...none(), paths: new Set([p]) }) },
  { name: 'owner signature', path: signaturePath(T, S), shape: 'signature', recorded: (p) => ({ ...none(), paths: new Set([p]) }) },
];

describe('orphan sweep covers every stored file shape', () => {
  for (const k of KNOWN) {
    it(`${k.name}: matches its shape, is kept while recorded, and is an orphan once nothing records it`, () => {
      expect(SWEEP_SHAPES[k.shape].test(k.path), k.path).toBe(true);
      expect(classify(k.path, T, k.recorded(k.path))).toBe('referenced');
      expect(classify(k.path, T, none())).toBe('orphan');
    });
  }

  it('every shape the sweep may delete has a known writer above (no dead or guessed shapes)', () => {
    expect([...new Set(KNOWN.map((k) => k.shape))].sort()).toEqual(Object.keys(SWEEP_SHAPES).sort());
  });

  it('brand images ({tenant}/{file}) are kept: referenced through brand_assets, never deleted when unknown', () => {
    for (const f of ['logo.png', 'logo_white.png', 'hero-wide-1400.jpg', 'van-1600.jpg', 'og.jpg']) {
      const p = `${T}/${f}`;
      expect(classify(p, T, { ...none(), paths: new Set([p]) })).toBe('referenced');
      expect(classify(p, T, none())).toBe('unknown');
    }
  });

  // Every place that writes to storage, by file. A new writer must be reviewed: add its path shape to KNOWN and to
  // the sweep (or confirm it can only produce an 'unknown', kept, shape), then list the file here.
  const REVIEWED_WRITERS: Record<string, string> = {
    'src/lib/documents/finalise.ts': 'previews and finalised request folders',
    'src/lib/data/documents.ts': 'demo previews and demo finals (demo-tenant, in memory)',
    'src/lib/data/surveys.ts': 'survey photos via photoPath (demo: demo-tenant)',
    'src/lib/data/signature-store.ts': 'signature via signaturePath (Settings upload and the FJC seed)',
  };
  it('no unreviewed code writes to storage', () => {
    const root = path.join(__dirname, '../..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const f = path.join(d, e);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(ts|tsx)$/.test(e)) files.push(f);
      }
    };
    walk(path.join(root, 'src'));
    const writers = files
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .filter((rel) => !rel.startsWith('src/lib/storage'))
      .filter((rel) => /\.put\(\s*[^,]+,\s*[^,]+,\s*'(application|image)\//.test(readFileSync(path.join(root, rel), 'utf8')));
    expect(writers.sort()).toEqual(Object.keys(REVIEWED_WRITERS).sort());
  });
});
