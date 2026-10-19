import { describe, expect, it } from 'vitest';
import { BRANDS } from '../../src/ai/brands';
import { missingFacts } from '../../src/ai/facts';
import { findInventions } from '../../src/ai/invention';
import { buildScopeCopySystem, SCOPE_COPY_PROMPT_VERSION } from '../../src/ai/prompts/scope-copy.v2';
import { acceptable } from '../../src/ai/scope-copy';
import { CLAIM_WORDS } from '../../src/ai/vocab/claims';
import { FJC_SCOPE_VOICE_V2, scopeVoiceFor } from '../../src/ai/voices';
import { DEFAULT_SECTION_HEADING } from '../../src/lib/scope/model';

const voice = FJC_SCOPE_VOICE_V2;

/** Every string in the voice, with where it came from. */
function allStrings(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  voice.headings.forEach((t) => out.push({ where: 'heading', text: t }));
  voice.referenceBullets.forEach((r) => [r.jobType, ...r.bullets].forEach((t) => out.push({ where: 'reference', text: t })));
  voice.examples.forEach((ex, i) => {
    const w = `example ${i + 1}`;
    out.push({ where: w, text: ex.jobType });
    ex.rough.forEach((g) => [g.heading ?? '', ...g.steps].forEach((t) => out.push({ where: w, text: t })));
    ex.wording.forEach((s) => [s.heading, ...s.steps].forEach((t) => out.push({ where: w, text: t })));
    [...ex.corrections, ...ex.uncertain].forEach((t) => out.push({ where: w, text: t }));
  });
  voice.checklist.forEach((c) => [c.question, ...c.coveredBy].forEach((t) => out.push({ where: 'checklist', text: t })));
  return out.filter((x) => x.text !== '');
}

// Generic material abbreviations are trade words, not brands.
const GENERIC = new Set(['osb', 'pvc', 'upvc', 'grp', 'epdm']);
// Capitalised words allowed mid-sentence: material abbreviations, and "Harris" (the made-up mishearing of "arris" in a rough step).
const CAPS_OK = new Set(['OSB', 'PVC', 'GRP', 'Harris']);

describe('the scope voice (tenant data)', () => {
  it('is versioned and is what every business gets for now', () => {
    expect(voice.version).toMatch(/^fjc-scope-voice\.v\d+$/);
    expect(scopeVoiceFor('any-tenant')).toBe(voice);
    expect(SCOPE_COPY_PROMPT_VERSION).toBe('scope-copy.v2');
  });

  it('holds no digits, prices, contact details, postcodes or customer details', () => {
    for (const { where, text } of allStrings()) {
      expect(text, where).not.toMatch(/\p{Nd}/u);
      expect(text, where).not.toMatch(/[£$€]|\bpounds?\b|\bpence\b/i);
      expect(text, where).not.toMatch(/@|www\.|https?:/i);
      expect(text, where).not.toMatch(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/);
      expect(text, where).not.toMatch(/\b(?:fjc|ben|cunningham|ltd|limited)\b/i);
    }
  });

  it('names no brand and no person or place', () => {
    for (const { where, text } of allStrings()) {
      for (const m of text.matchAll(/[\p{L}]+/gu)) {
        const w = m[0].toLowerCase();
        if (!GENERIC.has(w)) expect(BRANDS.includes(w), `${where}: ${m[0]}`).toBe(false);
      }
      for (const m of text.matchAll(/(?<=[\p{L},;:)]\s+)\p{Lu}[\p{L}]*/gu)) expect(CAPS_OK.has(m[0]), `${where}: ${m[0]}`).toBe(true);
    }
  });

  it('makes no claims in the bullets it teaches (the checklist may ask about a guarantee, as a question)', () => {
    const claims = new Set(CLAIM_WORDS);
    const taught = allStrings().filter((s) => s.where !== 'checklist');
    for (const { where, text } of taught) for (const m of text.toLowerCase().matchAll(/[a-z]+/g)) expect(claims.has(m[0]), `${where}: ${m[0]}`).toBe(false);
  });

  it('checklist items are questions, and short reference lists are marked rather than padded', () => {
    for (const c of voice.checklist) {
      expect(c.question.endsWith('?')).toBe(true);
      expect(c.coveredBy.length).toBeGreaterThan(0);
    }
    for (const r of voice.referenceBullets) if (r.bullets.length > 0 && r.bullets.length < 6) expect(r.shortOnPurpose, r.jobType).toBe(true);
  });

  it('every worked example passes the same checks as live output', () => {
    for (const [i, ex] of voice.examples.entries()) {
      const inputTexts = [ex.jobType, DEFAULT_SECTION_HEADING, ...ex.rough.flatMap((g) => [...(g.heading ? [g.heading] : []), ...g.steps])];
      const wording = ex.wording.flatMap((s) => [s.heading, ...s.steps]);
      expect(findInventions(inputTexts, [...wording, ...ex.corrections]), `example ${i + 1}`).toEqual([]);
      expect(missingFacts(ex.rough.flatMap((g) => g.steps), wording, ex.corrections), `example ${i + 1}`).toEqual([]);
      expect(acceptable({ sections: ex.wording, corrections: ex.corrections, uncertain: ex.uncertain }, ex.rough, inputTexts, voice.headings), `example ${i + 1}`).toBe(true);
      for (const u of ex.uncertain) expect(u.endsWith('?')).toBe(true);
      for (const c of ex.corrections) expect(c).toMatch(/^Read '[^']+' as(?: '[^']+'|: \(removed\))$/);
      const ownerSaidWeWill = ex.rough.some((g) => g.steps.some((t) => /^we will\b/i.test(t)));
      for (const s of ex.wording.flatMap((x) => x.steps)) if (!(ownerSaidWeWill && /^We will\b/.test(s))) expect(s, `example ${i + 1}`).not.toMatch(/^(?:We will|We are going|The )/);
    }
  });

  it('the system prompt carries the headings, the bullets and the examples, in UK English without dashes', () => {
    const system = buildScopeCopySystem(voice);
    for (const h of voice.headings) expect(system).toContain(`- ${h}`);
    for (const b of voice.referenceBullets.flatMap((r) => r.bullets)) expect(system).toContain(b);
    expect(system).toContain('Example 5');
    expect(system).not.toMatch(/[–—]/);
    expect(system.toLowerCase()).not.toMatch(/\bactually\b(?!")/);
  });
});
