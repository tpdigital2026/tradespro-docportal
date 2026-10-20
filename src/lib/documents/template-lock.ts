/**
 * The template lock (ben-template-lock-rule.md): a document drawn from a locked template uses exactly that template's
 * image files. Server only (reads files).
 *
 * Before a render: every image slot of the template is read from its own folder and checked against the sha256 in the
 * manifest; a missing or changed file blocks the document. After a render: every image slot on the pages must have
 * loaded, and the bytes each one shows must hash to the manifest's value; any image slot the template does not list,
 * or a listed one that is not on the pages, also blocks it. The owner sees one calm line; the details go to the log.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RenderPage } from '../../pdf/engine';
import type { Brand } from '../../themes/types';
import { templateById, type DocumentTemplate } from '../../templates/registry';

export const OWNER_TEMPLATE_MESSAGE = 'This template needs attention. Contact TradesPro Digital.';

export class TemplateLockError extends Error {
  constructor(
    readonly templateId: string,
    readonly problems: string[],
  ) {
    super(`Template ${templateId} is not intact: ${problems.join('; ')}`);
    this.name = 'TemplateLockError';
  }
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg' };

/** Where a business's template library lives (traced into the render functions by next.config.ts). */
export const libraryDir = (slug: string) => path.join(process.cwd(), 'src', 'templates', 'library', slug);

export type ReadFile = (file: string) => Buffer;

const cache = new Map<string, { stamp: string; bytes: Buffer }>();
/** Reads a library file, kept in memory per process (checked against its size and modification time). */
function cachedRead(file: string): Buffer {
  const st = statSync(file);
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.bytes;
  const bytes = readFileSync(file);
  cache.set(file, { stamp, bytes });
  return bytes;
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export type LoadedTemplate = { ok: true; template: DocumentTemplate; images: Record<string, string> } | { ok: false; templateId: string; problems: string[] };

/** The template's images as data: URIs by slot, each checked against the manifest's sha256. */
export function loadTemplate(id: string, read: ReadFile = cachedRead): LoadedTemplate {
  const template = templateById(id);
  if (!template) return { ok: false, templateId: id, problems: ['no such template in the registry'] };
  const dir = libraryDir(id.split('/')[0]);
  const images: Record<string, string> = {};
  const problems: string[] = [];
  for (const img of template.images) {
    const file = path.join(dir, img.file);
    let bytes: Buffer;
    try {
      bytes = read(file);
    } catch {
      problems.push(`${img.slot}: ${img.file} is missing`);
      continue;
    }
    if (bytes.length === 0) problems.push(`${img.slot}: ${img.file} is empty`);
    else if (sha256(bytes) !== img.sha256) problems.push(`${img.slot}: ${img.file} does not match the manifest (sha256 ${sha256(bytes).slice(0, 12)}…, expected ${img.sha256.slice(0, 12)}…)`);
    else images[img.slot] = `data:${MIME[path.extname(img.file)]};base64,${bytes.toString('base64')}`;
  }
  return problems.length ? { ok: false, templateId: id, problems } : { ok: true, template, images };
}

/** The brand to draw a templated document with: the template's own logos and images (the signature stays the owner's). */
export function applyTemplate(brand: Brand, t: Extract<LoadedTemplate, { ok: true }>): Brand {
  const i = t.images;
  return { ...brand, assets: { ...brand.assets, logoColour: i['logo-colour'] ?? brand.assets.logoColour, logoWhite: i['logo-white'] ?? brand.assets.logoWhite, templateImages: i } };
}

/** The template a mapped document names, if any. */
export function templateOf(input: unknown): string | undefined {
  const t = (input as { template?: unknown } | null)?.template;
  return typeof t === 'string' ? t : undefined;
}

/** One line for the server log (template id and what is wrong; never document content). */
export function logTemplateProblem(where: string, templateId: string, problems: string[]): void {
  console.error(`[template-lock] ${JSON.stringify({ where, template: templateId, problems })}`);
}

interface RenderedSlot {
  slot: string;
  src: string;
  loaded: boolean;
}

/** Every image slot on the loaded pages: its source and whether it decoded. */
export async function renderedSlots(page: RenderPage): Promise<RenderedSlot[]> {
  return page.evaluate(async () => {
    const out: { slot: string; src: string; loaded: boolean }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-slot]'))) {
      const slot = el.dataset.slot ?? '';
      if (el instanceof HTMLImageElement) {
        out.push({ slot, src: el.getAttribute('src') ?? '', loaded: el.complete && el.naturalWidth > 0 });
        continue;
      }
      const m = /url\(["']?(.*?)["']?\)$/.exec(getComputedStyle(el).backgroundImage);
      const src = m ? m[1] : '';
      const img = new Image();
      img.src = src;
      const loaded = src !== '' && (await img.decode().then(() => img.naturalWidth > 0, () => false));
      const box = el.getBoundingClientRect();
      out.push({ slot, src, loaded: loaded && box.width > 0 && box.height > 0 });
    }
    return out;
  });
}

/** The problems with the images on the rendered pages, against the template's manifest. Empty: intact. */
export function slotProblems(template: DocumentTemplate, slots: RenderedSlot[]): string[] {
  const problems: string[] = [];
  const expected = new Map(template.images.map((i) => [i.slot, i.sha256]));
  for (const s of slots) {
    const want = expected.get(s.slot);
    if (!want) {
      problems.push(`an image in slot "${s.slot}" is not part of the template`);
      continue;
    }
    if (!s.loaded) problems.push(`${s.slot}: the image did not load`);
    const m = /^data:[^;,]+;base64,(.*)$/.exec(s.src);
    if (!m) problems.push(`${s.slot}: the image is not embedded`);
    else if (sha256(Buffer.from(m[1], 'base64')) !== want) problems.push(`${s.slot}: the image shown is not the template's file`);
  }
  for (const slot of expected.keys()) if (!slots.some((s) => s.slot === slot)) problems.push(`${slot}: the template image is not on the pages`);
  return [...new Set(problems)];
}

/** After a render: throws TemplateLockError when any image slot failed to load or differs from the template's file. */
export async function verifyRenderedImages(page: RenderPage, templateId: string): Promise<void> {
  const template = templateById(templateId);
  if (!template) throw new TemplateLockError(templateId, ['no such template in the registry']);
  const problems = slotProblems(template, await renderedSlots(page));
  if (problems.length) {
    logTemplateProblem('render', templateId, problems);
    throw new TemplateLockError(templateId, problems);
  }
}
