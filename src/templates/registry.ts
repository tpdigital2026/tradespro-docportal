/**
 * The locked document templates (ben-template-lock-rule.md): one per business, document type and kind of job. A
 * template is a finished document; the app fills in only its data slots. Its images are fixed files stored with it
 * (src/templates/library/<business>/), named in its manifest with their sha256, and are never chosen, swapped or left
 * out by code or by the AI: src/lib/documents/template-lock.ts checks them by hash before and after every render.
 *
 * Pure (no file access): the manifest is imported, so the wording it holds is part of the build.
 * Fascia and guttering templates are parked by the owner (2026-10-20): those jobs have no template and keep the plain
 * layout, as do businesses without a template library.
 */
import { z } from 'zod';
import fjcManifest from './library/fjc/manifest.json';

export const DOCUMENT_TYPES = ['quotation', 'deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage', 'receipt', 'guarantee'] as const;
export type TemplateDocType = (typeof DOCUMENT_TYPES)[number];
export const VARIANTS = ['flat-roof', 'tiled-roof', 'tiled-and-flat-roof', 'commercial-roofing'] as const;
export type TemplateVariant = (typeof VARIANTS)[number];

const text = z.string().trim().min(1);
const diagram = z.discriminatedUnion('layout', [
  z.strictObject({ layout: z.literal('single'), image: text, eyebrow: text, heading: text, body: z.array(text).max(3), caption: z.string() }),
  z.strictObject({ layout: z.literal('pair'), items: z.array(z.strictObject({ image: text, label: text })).length(2), caption: z.string() }),
]);
const imageSlot = z.strictObject({
  slot: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  file: z.string().regex(/^[a-z0-9-]+\/[a-z0-9_-]+\.(png|jpg)$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: text,
});
const quoteWording = z.strictObject({
  sector: z.strictObject({ residential: text, commercial: text }),
  specEyebrow: text,
  specHeading: text,
  scopeHeading: text,
  diagram: diagram.nullable(),
  guaranteeBand: text,
});
const template = z.strictObject({
  id: z.string().regex(/^[a-z]+\/[a-z-]+\/[a-z-]+$/),
  documentType: z.enum(DOCUMENT_TYPES),
  jobType: text,
  variant: z.enum(VARIANTS),
  reference: text,
  images: z.array(imageSlot).min(1),
  slots: z.array(text).min(1),
  wording: quoteWording.optional(),
});
export const manifestSchema = z.strictObject({ $comment: z.string().optional(), tenant: z.string().regex(/^[a-z0-9-]+$/), version: z.number().int(), templates: z.array(template) });

export type TemplateManifest = z.infer<typeof manifestSchema>;
export type DocumentTemplate = z.infer<typeof template>;
export type QuoteTemplateWording = z.infer<typeof quoteWording>;
export type TemplateDiagram = z.infer<typeof diagram>;

/** Every business's template library, by its slug. Parsed once: a broken manifest fails the build's tests, not a render. */
export const LIBRARIES: Record<string, TemplateManifest> = { fjc: manifestSchema.parse(fjcManifest) };

/** The template for this business, document type and kind of job, or null (no library, or a parked kind of job). */
export function templateFor(slug: string | null | undefined, documentType: TemplateDocType, variant: TemplateVariant | null): DocumentTemplate | null {
  if (!slug || !variant) return null;
  return LIBRARIES[slug]?.templates.find((t) => t.documentType === documentType && t.variant === variant) ?? null;
}

export function templateById(id: string): DocumentTemplate | null {
  const slug = id.split('/')[0];
  return LIBRARIES[slug]?.templates.find((t) => t.id === id) ?? null;
}
