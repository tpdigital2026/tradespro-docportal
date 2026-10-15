import { z } from 'zod';
import { sha256Hex } from './hash';
import { stripInvisible } from './invisible';

/**
 * The scope of works, as the owner builds it: ordered one-sentence steps (optionally grouped under headings),
 * the cover, key figures and a note. The steps are the original and are never overwritten; the tidied copy is
 * kept beside them, and counts as approved only while it was made from exactly these steps.
 */

export const SCOPE_LIMITS = {
  heading: 80,
  step: 300,
  stepsPerSection: 30,
  sections: 12,
  specCards: 4,
  specValue: 40,
  specLabel: 40,
  coverTitle: 120,
  coverSub: 160,
  intro: 1200,
  note: 1200,
  /** 12 headings and 30 steps in each of 13 groups (a leading group with no heading) */
  items: 12 + 13 * 30,
  /** corrections and uncertain lists */
  notes: 60,
} as const;

/** The old one-box scope notes were limited to 4000 characters, so real overflow is far below this. */
export const LEGACY_OVERFLOW_MAX = 8000;

export const NOTE_LABEL = 'Please note';
export const DEFAULT_SECTION_HEADING = 'The works';

export type ScopeItemKind = 'heading' | 'step';
export interface ScopeItem {
  id: string;
  kind: ScopeItemKind;
  text: string;
}
export interface SpecCardValue {
  value: string;
  label: string;
}
export interface CopySection {
  heading: string;
  steps: string[];
}
export type ScopeEngine = 'ai' | 'fallback';
export interface ScopeCopy {
  sections: CopySection[];
  corrections: string[];
  uncertain: string[];
  engine: ScopeEngine;
  generatedAt: string;
  /** Which steps this copy was made from. Checked by the server's proof. */
  sourceKey: string;
  /** Server proof that engine, sourceKey, generatedAt and genKey came from the server for this business (an HMAC; the browser cannot make one). */
  proof: string;
  /** Fingerprint of the wording exactly as it was generated. The proof covers it, so an engine label can only go with the wording it was made for. Editing the wording afterwards does not change it. */
  genKey?: string;
  /** Written only by the server when the wording is approved. */
  approvedAt: string | null;
  /** Fingerprint of the exact steps, wording and note that were approved. Approval holds only while it still matches. */
  approvalHash: string | null;
}
export interface ScopeFormValues {
  coverTitle: string;
  coverSub: string;
  intro: string;
  specCards: SpecCardValue[];
  note: string;
  items: ScopeItem[];
  copy: ScopeCopy | null;
  /**
   * Old-style notes that did not fit in the steps (a draft from before the builder, more text than the limits allow).
   * Kept until the owner discards it on purpose (set to ''); the autosave never drops it.
   */
  legacyOverflow?: string;
}

export const emptyScope = (): ScopeFormValues => ({ coverTitle: '', coverSub: '', intro: '', specCards: [], note: '', items: [], copy: null });

// ------------------------------------------------------------------ zod (shape and size; what the browser may send)

const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const BAD = 'That has characters we cannot save';

const line = (max: number) => z.string().max(max).refine((v) => !CONTROL.test(v), BAD);
const para = (max: number) => z.string().max(max).refine((v) => !CONTROL_KEEP_NEWLINE.test(v), BAD);

export const scopeItemSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    kind: z.enum(['heading', 'step']),
    text: line(SCOPE_LIMITS.step),
  })
  .refine((i) => i.kind !== 'heading' || i.text.length <= SCOPE_LIMITS.heading, { message: `Keep a heading to ${SCOPE_LIMITS.heading} characters or fewer`, path: ['text'] });

export const copySectionSchema = z.object({
  heading: line(SCOPE_LIMITS.heading),
  steps: z.array(line(SCOPE_LIMITS.step)).max(SCOPE_LIMITS.stepsPerSection),
});

export const scopeCopySchema = z.object({
  sections: z.array(copySectionSchema).max(SCOPE_LIMITS.sections + 1),
  corrections: z.array(line(SCOPE_LIMITS.step)).max(SCOPE_LIMITS.notes),
  uncertain: z.array(line(SCOPE_LIMITS.step)).max(SCOPE_LIMITS.notes),
  engine: z.enum(['ai', 'fallback']),
  generatedAt: z.string().max(40),
  sourceKey: z.string().max(60),
  proof: z.string().max(100).default(''),
  genKey: z.string().max(80).optional(),
  approvedAt: z.string().max(40).nullable(),
  approvalHash: z.string().max(80).nullable().default(null),
});

export const scopeFormSchema = z.object({
  coverTitle: line(SCOPE_LIMITS.coverTitle),
  coverSub: line(SCOPE_LIMITS.coverSub),
  intro: para(SCOPE_LIMITS.intro),
  specCards: z.array(z.object({ value: line(SCOPE_LIMITS.specValue), label: line(SCOPE_LIMITS.specLabel) })).max(SCOPE_LIMITS.specCards),
  note: para(SCOPE_LIMITS.note),
  items: z.array(scopeItemSchema).max(SCOPE_LIMITS.items),
  copy: scopeCopySchema.nullable(),
  legacyOverflow: para(LEGACY_OVERFLOW_MAX).optional(),
});

// ------------------------------------------------------------------ tidy text

const BULLET_PREFIX = /^(?:[-*•\u2013\u2014]+|\(?\d{1,3}[.)])\s+/;

/** One line, single spaces, no list marker. Wording is untouched. */
export function cleanLine(raw: string): string {
  let s = stripInvisible(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  while (BULLET_PREFIX.test(s)) s = s.replace(BULLET_PREFIX, '').trim();
  return s;
}

/** Item with its text cleaned. Blank text stays blank (the caller decides to drop it). */
export function cleanItems(items: readonly ScopeItem[]): ScopeItem[] {
  return items.map((i) => ({ ...i, text: cleanLine(i.text) }));
}

/** Items that say something, in order. Blank boxes are ignored everywhere. */
export function meaningfulItems(items: readonly ScopeItem[]): ScopeItem[] {
  return cleanItems(items).filter((i) => i.text !== '');
}

export interface Group {
  heading: string | null;
  steps: string[];
}

/** Group the steps under their headings. Steps before the first heading form a group with no heading. */
export function groupItems(items: readonly ScopeItem[]): Group[] {
  const groups: Group[] = [];
  for (const i of meaningfulItems(items)) {
    if (i.kind === 'heading') groups.push({ heading: i.text, steps: [] });
    else {
      const last = groups[groups.length - 1];
      if (last) last.steps.push(i.text);
      else groups.push({ heading: null, steps: [i.text] });
    }
  }
  return groups;
}

export function countSteps(items: readonly ScopeItem[]): number {
  return meaningfulItems(items).filter((i) => i.kind === 'step').length;
}

/** A short fingerprint of the steps (order and wording, not ids). Not a secret. */
export function scopeKey(items: readonly ScopeItem[]): string {
  const canon = meaningfulItems(items).map((i) => `${i.kind === 'heading' ? 'h' : 's'}:${i.text}`).join('\n');
  return `k1.${canon.length}.${cyrb53(canon).toString(36)}`;
}

function cyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Fingerprint of what is approved: the exact steps, the exact wording (groups and lines) and the note (the box the
 * customer also reads). Anything that changes any of them changes this.
 */
export function approvalHash(scope: ScopeFormValues): string {
  const steps = meaningfulItems(scope.items).map((i) => [i.kind === 'heading' ? 'h' : 's', i.text]);
  const sections = scope.copy ? cleanCopySections(scope.copy.sections).map((s) => [s.heading, s.steps]) : [];
  // Everything the customer reads: the cover, the introduction, the key figures and the note, as well as the steps and wording.
  const cover = [cleanLine(scope.coverTitle), cleanLine(scope.coverSub), cleanPara(scope.intro)];
  const cards = scope.specCards.map((c) => [cleanLine(c.value), cleanLine(c.label)]).filter((c) => c[0] !== '' || c[1] !== '');
  return `h${sha256Hex(JSON.stringify({ v: 2, steps, sections, cover, cards, note: cleanPara(scope.note) }))}`;
}

/** A paragraph box: invisible characters out, line ends made plain, trimmed. */
export function cleanPara(raw: string): string {
  return stripInvisible(raw).replace(/\r\n?/g, '\n').trim();
}

/** Fingerprint of generated wording (groups and lines). */
/** Said when approving copy whose server proof has expired (made more than a day ago). Shared with the screen. */
export const COPY_TOO_OLD = 'This copy is more than a day old. Generate it again, then approve.';

/** The owner has changed the wording since it was generated (the generated fingerprint no longer matches). */
export function wordingEdited(copy: ScopeCopy | null): boolean {
  return !!copy?.genKey && copy.genKey !== sectionsKey(copy.sections);
}

export function sectionsKey(sections: readonly CopySection[]): string {
  return `g${sha256Hex(JSON.stringify(cleanCopySections(sections).map((s) => [s.heading, s.steps])))}`;
}

/** Approved only while the steps, wording and note are exactly what was approved. */
export function isApproved(scope: ScopeFormValues): boolean {
  const c = scope.copy;
  if (!c || c.approvedAt === null || c.approvalHash === null) return false;
  if (!c.sections.some((s) => s.steps.some((b) => b.trim() !== ''))) return false;
  return c.approvalHash === approvalHash(scope);
}

/** The approval fields cleared. Used whenever the content no longer matches what was approved. */
export function withoutApproval(scope: ScopeFormValues): ScopeFormValues {
  return scope.copy && (scope.copy.approvedAt !== null || scope.copy.approvalHash !== null) ? { ...scope, copy: { ...scope.copy, approvedAt: null, approvalHash: null } } : scope;
}

/** The copy has gone stale: it exists but was made from different steps. */
export function isStale(scope: ScopeFormValues): boolean {
  return !!scope.copy && scope.copy.sourceKey !== scopeKey(scope.items);
}

// ------------------------------------------------------------------ validation (plain-language messages)

export type ScopeErrors = Record<string, string>;

/** Keys all start with "scope". 'draft' reports only length problems; 'final' also what is missing and the approval. */
export function scopeErrors(scope: ScopeFormValues, mode: 'draft' | 'final'): ScopeErrors {
  const e: ScopeErrors = {};
  const L = SCOPE_LIMITS;
  const title = scope.coverTitle.trim();
  if (mode === 'final' && title === '') e['scope.coverTitle'] = 'Give the quote a title';
  if (title.length > L.coverTitle) e['scope.coverTitle'] = `Keep the title to ${L.coverTitle} characters or fewer`;
  if (scope.coverSub.trim().length > L.coverSub) e['scope.coverSub'] = `Keep this to ${L.coverSub} characters or fewer`;
  if (scope.intro.trim().length > L.intro) e['scope.intro'] = `Keep the introduction to ${L.intro} characters or fewer`;
  if (scope.note.trim().length > L.note) e['scope.note'] = `Keep the note to ${L.note} characters or fewer`;

  if (scope.specCards.length > L.specCards) e['scope.specCards'] = `Use at most ${L.specCards} key figures`;
  scope.specCards.forEach((c, i) => {
    const v = c.value.trim();
    const l = c.label.trim();
    if (v.length > L.specValue) e[`scope.specCards.${i}.value`] = `Keep this to ${L.specValue} characters or fewer`;
    if (l.length > L.specLabel) e[`scope.specCards.${i}.label`] = `Keep this to ${L.specLabel} characters or fewer`;
    if (mode === 'final' && (v === '') !== (l === '')) {
      e[`scope.specCards.${i}.${v === '' ? 'value' : 'label'}`] = v === '' ? 'Add the figure, or remove this card' : 'Say what the figure is, or remove this card';
    }
  });

  const items = meaningfulItems(scope.items);
  items.forEach((it) => {
    if (it.kind === 'heading' && it.text.length > L.heading) e[`scope.item.${it.id}`] = `Keep a heading to ${L.heading} characters or fewer`;
    if (it.kind === 'step' && it.text.length > L.step) e[`scope.item.${it.id}`] = `Keep a step to ${L.step} characters or fewer`;
  });
  const groups = groupItems(scope.items);
  if (groups.length > L.sections) e['scope.items'] = `A quote can have at most ${L.sections} headings`;
  else if (groups.some((g) => g.steps.length > L.stepsPerSection)) e['scope.items'] = `Keep each heading to ${L.stepsPerSection} steps or fewer`;

  if (mode === 'final') {
    if (countSteps(scope.items) === 0) e['scope.items'] = 'Add at least one step';
    else if (!e['scope.items'] && !isApproved(scope)) {
      e['scope.approval'] = isStale(scope)
        ? 'You changed the steps after the wording was made. Generate the copy again and approve it.'
        : scope.copy
          ? 'Check the wording and approve it before the price.'
          : 'Generate the copy and approve it before the price.';
    }
  }
  return e;
}

/** Errors in the approved copy itself (what the customer will read). Used before approving. */
export function copyErrors(copy: ScopeCopy): ScopeErrors {
  const e: ScopeErrors = {};
  const L = SCOPE_LIMITS;
  const parsed = scopeCopySchema.safeParse(copy);
  if (!parsed.success) e['scope.copy'] = 'Some of the wording is too long or has characters we cannot save';
  let any = false;
  copy.sections.forEach((s, i) => {
    const steps = s.steps.map((x) => x.trim()).filter(Boolean);
    if (steps.length === 0) return;
    any = true;
    const heading = s.heading.trim();
    if (heading === '') e[`scope.copy.${i}`] = 'Every group needs a heading';
    if (heading.length > L.heading) e[`scope.copy.${i}`] = `Keep a heading to ${L.heading} characters or fewer`;
    if (steps.length > L.stepsPerSection) e[`scope.copy.${i}`] = `Keep each heading to ${L.stepsPerSection} steps or fewer`;
    if (steps.some((x) => x.length > L.step)) e[`scope.copy.${i}`] = `Keep each step to ${L.step} characters or fewer`;
  });
  if (!any) e['scope.copy'] = 'There is no wording to approve';
  return e;
}

/** Trim a copy for storing or mapping: no blank steps, no empty groups. */
export function cleanCopySections(sections: readonly CopySection[]): CopySection[] {
  return sections
    .map((s) => ({ heading: cleanLine(s.heading), steps: s.steps.map(cleanLine).filter(Boolean) }))
    .filter((s) => s.steps.length > 0);
}
