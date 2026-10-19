import { describe, expect, it } from 'vitest';
import type { ModelClient, ModelRequest } from '../../src/ai/client';
import { addedWork, missingFacts, newDigits } from '../../src/ai/facts';
import { generateScopeCopy } from '../../src/ai/scope-copy';
import { scopeCopyResponseSchemaV2 } from '../../src/ai/schemas';
import { suggestionsFor, typicalStepsFrom } from '../../src/ai/suggestions';
import { FJC_SCOPE_VOICE_V2 } from '../../src/ai/voices';
import { FJC_SCOPE_EXAMPLES } from '../../src/lib/scope/fjc-examples';
import { scopeCopySchema, type ScopeItem } from '../../src/lib/scope/model';

const items = (...t: string[]): ScopeItem[] => t.map((text, i) => ({ id: `s${i}`, kind: text.startsWith('#') ? 'heading' : 'step', text: text.replace(/^#/, '') }));
const stub = (replies: string[], seen: ModelRequest[] = []): ModelClient => ({
  async complete(req) {
    seen.push(req);
    return { text: replies[Math.min(seen.length - 1, replies.length - 1)]!, inputTokens: 1, outputTokens: 1 };
  },
});
type Sec = { group?: number; heading: string; steps: string[] };
const reply = (sections: Sec[], corrections: string[] = [], uncertain: string[] = []) => JSON.stringify({ sections, corrections, uncertain });
const run = (steps: ScopeItem[], answer: string, jobType = 'Flat roof', typicalSteps: string[] = []) =>
  generateScopeCopy({ steps, jobType, typicalSteps }, { client: stub([answer, answer]), model: 'm' });

describe('prompt v2 answers (stubbed client)', () => {
  it("the owner's live example: dictation noise removed and listed, 12 hours kept, imperative", async () => {
    const steps = items("set up sc yes we're going to set up the scaffolding and this will take 12 hours", 'take of exisitng roof');
    const r = await run(steps, reply([{ group: 0, heading: 'The works', steps: ['Set up the scaffolding (12 hours)', 'Take off the existing roof'] }], ["Read 'sc yes' as: (removed)", "Read 'take of' as 'take off'", "Read 'exisitng' as 'existing'"]));
    expect(r.engine).toBe('ai');
    expect(r.sections).toEqual([{ heading: 'The works', steps: ['Set up the scaffolding (12 hours).', 'Take off the existing roof.'] }]);
    expect(r.corrections).toContain("Read 'sc yes' as: (removed)");
  });

  it('a step with two pieces of work may become two bullets, but not more than two per step', async () => {
    const steps = items('strip the roof and fit new felt');
    expect((await run(steps, reply([{ group: 0, heading: 'The works', steps: ['Strip the roof', 'Fit new felt'] }]))).engine).toBe('ai');
    expect((await run(steps, reply([{ group: 0, heading: 'The works', steps: ['Strip the roof', 'Fit new felt', 'Fit the roof'] }]))).engine).toBe('fallback');
  });

  describe('headings', () => {
    const steps = items('skip on the drive', 'strip off the old felt', 'perforated tack down layer', 'cap sheet with drip edges');
    it("steps with no heading may be grouped under the business's own headings, in order", async () => {
      const r = await run(
        steps,
        reply([
          { group: 0, heading: 'Site set-up', steps: ['Provide a skip on the drive'] },
          { group: 0, heading: 'Strip-out and removal', steps: ['Strip off the old felt'] },
          { group: 0, heading: 'Felt roofing system', steps: ['Install a perforated tack-down layer', 'Install a cap sheet with drip edges'] },
        ]),
      );
      expect(r.engine).toBe('ai');
      expect(r.sections.map((s) => s.heading)).toEqual(['Site set-up', 'Strip-out and removal', 'Felt roofing system']);
    });
    it.each([
      ['an invented heading', [{ group: 0, heading: 'Preparation', steps: ['Provide a skip on the drive', 'Strip off the old felt'] }, { group: 0, heading: 'Felt roofing system', steps: ['Install a perforated tack-down layer', 'Install a cap sheet with drip edges'] }]],
      ['an own heading whose trade words the owner never wrote', [{ group: 0, heading: 'Site set-up', steps: ['Provide a skip on the drive', 'Strip off the old felt'] }, { group: 0, heading: 'Lead flashing', steps: ['Install a perforated tack-down layer', 'Install a cap sheet with drip edges'] }]],
      ['a single section with an invented heading', [{ group: 0, heading: 'Roof works', steps: ['Provide a skip on the drive', 'Strip off the old felt', 'Install a perforated tack-down layer', 'Install a cap sheet with drip edges'] }]],
      ['a group left out', [{ group: 1, heading: 'The works', steps: ['Provide a skip on the drive'] }]],
    ])('refuses %s', async (_n, sections) => {
      expect((await run(steps, reply(sections as Sec[]))).engine).toBe('fallback');
    });
    it("a group with the owner's own heading stays one section", async () => {
      const s2 = items('#strip out', 'strip off the old felt', 'skip on the drive');
      expect((await run(s2, reply([{ group: 0, heading: 'Strip out', steps: ['Strip off the old felt', 'Provide a skip on the drive'] }]))).engine).toBe('ai');
      expect((await run(s2, reply([{ group: 0, heading: 'Strip-out and removal', steps: ['Strip off the old felt'] }, { group: 0, heading: 'Site set-up', steps: ['Provide a skip on the drive'] }]))).engine).toBe('fallback');
    });
    it('a v1-shaped answer (no group numbers) still maps one section to each group', async () => {
      expect((await run(items('strip off the old felt'), reply([{ heading: 'The works', steps: ['Strip off the old felt'] }]))).engine).toBe('ai');
    });
  });

  describe('facts', () => {
    it('refuses wording that drops a figure or changes its unit', async () => {
      const steps = items('scaffold up for 12 hours');
      expect((await run(steps, reply([{ group: 0, heading: 'The works', steps: ['Erect the scaffold'] }]))).engine).toBe('fallback');
      expect((await run(steps, reply([{ group: 0, heading: 'The works', steps: ['Erect the scaffold (12 days)'] }]))).engine).toBe('fallback');
      expect((await run(steps, reply([{ group: 0, heading: 'The works', steps: ['Erect the scaffold (12 hours)'] }]))).engine).toBe('ai');
    });
    it('refuses wording that drops a name, unless the corrections say it was read as something else', async () => {
      expect((await run(items('lead work done by Dave'), reply([{ group: 0, heading: 'The works', steps: ['Do the lead work'] }]))).engine).toBe('fallback');
      expect((await run(items('fit new Harris rails'), reply([{ group: 0, heading: 'The works', steps: ['Fit new arris rails'] }], ["Read 'Harris rails' as 'arris rails'"]))).engine).toBe('ai');
      expect(missingFacts(['fit new Harris rails'], ['Fit new arris rails'])).toEqual([{ kind: 'name', text: 'Harris' }]);
    });
    it("keeps the owner's form of a figure: words stay words, and says why an answer was refused", async () => {
      expect(newDigits(['replace two or three joists'], ['Replace 2 or 3 joists'])).toEqual(['2', '3']);
      expect(newDigits(['replace 2 joists'], ['Replace 2 joists'])).toEqual([]);
      const reasons: string[] = [];
      const r = await generateScopeCopy(
        { steps: items('replace two or three joists'), jobType: '' },
        { client: stub([reply([{ group: 0, heading: 'The works', steps: ['Replace 2 or 3 joists'] }])]), onReject: (w) => reasons.push(w) },
      );
      expect(r.engine).toBe('fallback');
      expect(reasons).toEqual(['figure-form', 'figure-form']);
    });
    it('refuses a placeholder from the reference bullets showing up in the wording', async () => {
      const reasons: string[] = [];
      const r = await generateScopeCopy(
        { steps: items('breathable membrane'), jobType: '' },
        { client: stub([reply([{ group: 0, heading: 'The works', steps: ['Install breathable membrane [product named by the owner]'] }])]), onReject: (w) => reasons.push(w) },
      );
      expect(r.engine).toBe('fallback');
      expect(reasons).toEqual(['placeholder', 'placeholder']);
    });
    it('refuses a bullet that is new work (nothing in common with what the owner wrote)', async () => {
      const r = await run(items('strip off the old felt'), reply([{ group: 0, heading: 'The works', steps: ['Strip off the old felt', 'Lay protection to floors and walls'] }]));
      expect(r.engine).toBe('fallback');
      expect(addedWork(['strip off the old felt'], ['Lay protection to floors and walls'])).toHaveLength(1);
      expect(addedWork(['tidy up'], ['Clear the site'])).toEqual([]);
    });
  });

  describe('dictation and questions', () => {
    it('a "please check" question may name a part the owner did not write; never a figure, brand or claim', async () => {
      const steps = items('put the scuffle up');
      const ok = reply([{ group: 0, heading: 'The works', steps: ['Put the scuffle up'] }], [], ['"Put the scuffle up": did you mean scaffold?']);
      expect((await run(steps, ok)).uncertain).toEqual(['"Put the scuffle up": did you mean scaffold?']);
      for (const q of ['Did you mean 2 scaffold towers?', 'Did you mean Marley tiles?', 'Is it guaranteed?']) {
        expect((await run(steps, reply([{ group: 0, heading: 'The works', steps: ['Put the scuffle up'] }], [], [q]))).engine).toBe('fallback');
      }
    });
    it('the wording itself may never gain a product word from a guess', async () => {
      const r = await run(items('put the scuffle up'), reply([{ group: 0, heading: 'The works', steps: ['Erect the scaffold'] }], ["Read 'scuffle' as 'scaffold'"]));
      expect(r.engine).toBe('fallback');
    });
    it('the response schema takes group numbers and refuses junk', () => {
      expect(scopeCopyResponseSchemaV2.safeParse({ sections: [{ group: 0, heading: 'A', steps: ['b'] }], corrections: [], uncertain: [] }).success).toBe(true);
      expect(scopeCopyResponseSchemaV2.safeParse({ sections: [{ group: -1, heading: 'A', steps: ['b'] }], corrections: [], uncertain: [] }).success).toBe(false);
      expect(scopeCopyResponseSchemaV2.safeParse({ sections: [{ group: 0.5, heading: 'A', steps: ['b'] }], corrections: [], uncertain: [] }).success).toBe(false);
    });
  });
});

describe('Things you could add', () => {
  const voice = FJC_SCOPE_VOICE_V2;
  const flatTypical = typicalStepsFrom(FJC_SCOPE_EXAMPLES.flat_roof);

  it('asks about what the business always covers when the steps say nothing about it, as questions only', () => {
    const s = suggestionsFor({ ownerTexts: ['strip off the old felt', 'lay new felt'], jobType: 'Flat roof', checklist: voice.checklist, typicalSteps: flatTypical });
    expect(s.length).toBe(5);
    expect(s.map((x) => x.question)).toEqual(voice.checklist.slice(0, 5).map((c) => c.question));
    for (const x of s) expect(x.question.endsWith('?')).toBe(true);
  });

  it('does not ask about what the owner already covered, and asks about the roof area only on roof jobs', () => {
    const covered = suggestionsFor({ ownerTexts: ['scaffolding to the front', 'skip on the drive', 'dust sheets down', 'roof area 24 m2', '20 year guarantee', 'no extras'], jobType: 'Flat roof', checklist: voice.checklist, typicalSteps: [] });
    expect(covered).toEqual([]);
    const gutter = suggestionsFor({ ownerTexts: ['scaffolding', 'skip', 'dust sheets', 'guarantee', 'extras'], jobType: 'Guttering', checklist: voice.checklist, typicalSteps: [] });
    expect(gutter).toEqual([]);
  });

  it("then the business's usual steps for the job type that were not mentioned, with the step one tap adds", () => {
    const s = suggestionsFor({ ownerTexts: ['scaffolding', 'skip', 'dust sheets', 'roof area', 'guarantee', 'extras', 'remove the existing roof covering'], jobType: 'Flat roof', checklist: voice.checklist, typicalSteps: flatTypical });
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) {
      expect(flatTypical).toContain(x.step);
      expect(x.question).toBe(`Do you need a step to ${x.step!.charAt(0).toLowerCase()}${x.step!.slice(1)}?`);
    }
    expect(s.some((x) => x.step === 'Remove the existing roof covering')).toBe(false);
  });

  it('comes back with both engines and never appears in the wording', async () => {
    const steps = items('strip off the old felt');
    const basic = await generateScopeCopy({ steps, jobType: 'Flat roof', typicalSteps: flatTypical }, { client: null });
    const ai = await run(steps, reply([{ group: 0, heading: 'The works', steps: ['Strip off the old felt'] }]), 'Flat roof', flatTypical);
    for (const r of [basic, ai]) {
      expect(r.suggestions.length).toBeGreaterThan(0);
      const wording = r.sections.flatMap((x) => x.steps).join(' ');
      for (const q of r.suggestions) expect(wording).not.toContain(q.question);
    }
    expect(ai.suggestions).toEqual(basic.suggestions);
  });

  it('is stored with the copy (optional, so older copies still load)', () => {
    const base = { sections: [], corrections: [], uncertain: [], engine: 'ai', generatedAt: 'x', sourceKey: 'k', proof: '', approvedAt: null, approvalHash: null };
    expect(scopeCopySchema.safeParse(base).success).toBe(true);
    expect(scopeCopySchema.safeParse({ ...base, suggestions: [{ question: 'Who?', step: null }] }).success).toBe(true);
    expect(scopeCopySchema.safeParse({ ...base, suggestions: Array(6).fill({ question: 'Who?', step: null }) }).success).toBe(false);
  });
});
