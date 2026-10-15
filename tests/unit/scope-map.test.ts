import { describe, expect, it } from 'vitest';
import type { QuotationInput } from '../../src/templates/quotation';
import { parseScopeExamples, scopeExamplesSchema } from '../../src/lib/scope/examples';
import { applyJobTypeDefaults, autoTitle, isPristine } from '../../src/lib/scope/defaults';
import { FJC_SCOPE_EXAMPLES } from '../../src/lib/scope/fjc-examples';
import { emptyScope, NOTE_LABEL } from '../../src/lib/scope/model';
import { toQuotationScope } from '../../src/lib/scope/to-quotation';
import { approvedScope, STEPS } from '../fixtures/scope';

describe('toQuotationScope', () => {
  it('maps the approved copy, cover, key figures and note onto the quotation', () => {
    const r = toQuotationScope(
      approvedScope({
        coverTitle: '  Flat roof quotation ',
        coverSub: 'Full scope and pricing',
        intro: 'We are pleased to quote.\r\nThank you.',
        specCards: [{ value: ' 24 m2 ', label: 'Roof area' }, { value: '', label: '' }],
        note: ' Scaffold not included. ',
      }),
    );
    expect(r).toEqual({
      ok: true,
      value: {
        coverTitle: 'Flat roof quotation',
        coverSub: 'Full scope and pricing',
        introText: 'We are pleased to quote.\nThank you.',
        specCards: [{ big: '24 m2', label: 'Roof area' }],
        callout: { label: NOTE_LABEL, text: 'Scaffold not included.' },
        scope: [{ heading: 'Preparation', bullets: ['Strip off the existing roof covering.', 'Take all waste away.'] }],
      },
    });
  });
  it('fits the quotation template\'s own types', () => {
    const r = toQuotationScope(approvedScope());
    if (!r.ok) throw new Error('expected ok');
    const part: Pick<QuotationInput, 'coverTitle' | 'coverSub' | 'introText' | 'specCards' | 'callout' | 'scope'> = r.value;
    expect(part.scope[0]!.bullets).toHaveLength(2);
  });
  it('uses the approved copy, never the raw steps', () => {
    const r = toQuotationScope(approvedScope());
    if (!r.ok) throw new Error('expected ok');
    expect(JSON.stringify(r.value.scope)).not.toContain('strip off the existing');
  });
  it('no note means no callout; drops blank bullets and empty groups', () => {
    const s = approvedScope();
    const r = toQuotationScope({ ...s, note: '  ', copy: { ...s.copy!, sections: [...s.copy!.sections, { heading: 'Empty', steps: [' '] }, { heading: ' Fit ', steps: ['', ' Fit it. '] }] } });
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.callout).toBeNull();
    expect(r.value.scope.map((x) => x.heading)).toEqual(['Preparation', 'Fit']);
    expect(r.value.scope[1]!.bullets).toEqual(['Fit it.']);
  });
  it.each([
    ['not approved', () => approvedScope({ copy: { ...approvedScope().copy!, approvedAt: null } })],
    ['no copy', () => approvedScope({ copy: null })],
    ['steps changed after approval', () => approvedScope({ items: [...STEPS, { id: 'z', kind: 'step', text: 'More work' }], copy: approvedScope().copy })],
    ['no title', () => approvedScope({ coverTitle: '  ' })],
    ['a half-filled key figure', () => approvedScope({ specCards: [{ value: '24 m2', label: '' }] })],
  ])('refuses: %s', (_n, make) => {
    const r = toQuotationScope(make());
    expect(r.ok).toBe(false);
  });
});

describe('job type defaults', () => {
  const types = [
    { id: 'a', label: 'Flat roof', scopeExamples: { intro: 'Intro A', specLabels: [], headings: [], starters: [], sequences: [] } },
    { id: 'b', label: 'Tiled roof', scopeExamples: { intro: 'Intro B', specLabels: [], headings: [], starters: [], sequences: [] } },
    { id: 'c', label: 'Other', scopeExamples: null },
  ];
  it('title and intro follow the job type while the owner has not written their own', () => {
    let s = applyJobTypeDefaults(emptyScope(), types, '', 'a');
    expect(s.coverTitle).toBe('Flat roof quotation');
    expect(s.intro).toBe('Intro A');
    s = applyJobTypeDefaults(s, types, 'a', 'b');
    expect([s.coverTitle, s.intro]).toEqual(['Tiled roof quotation', 'Intro B']);
    s = applyJobTypeDefaults(s, types, 'b', 'c');
    expect([s.coverTitle, s.intro]).toEqual(['Other quotation', '']);
  });
  it('never overwrites what the owner typed', () => {
    const typed = { ...emptyScope(), coverTitle: 'Roof for Mr Smith', intro: 'My own words.' };
    const s = applyJobTypeDefaults(typed, types, 'a', 'b');
    expect([s.coverTitle, s.intro]).toEqual(['Roof for Mr Smith', 'My own words.']);
  });
  it('autoTitle and pristine', () => {
    expect(autoTitle(undefined)).toBe('Quotation');
    expect(autoTitle(' Fascias ')).toBe('Fascias quotation');
    expect(isPristine(emptyScope())).toBe(true);
    expect(isPristine({ ...emptyScope(), note: 'x' })).toBe(false);
  });
});

describe('the business\'s own example wording', () => {
  it('FJC\'s data fits the schema', () => {
    for (const [key, ex] of Object.entries(FJC_SCOPE_EXAMPLES)) {
      expect(scopeExamplesSchema.safeParse(ex).success, key).toBe(true);
    }
    expect(Object.keys(FJC_SCOPE_EXAMPLES).sort()).toEqual(['fascia', 'flat_roof', 'other', 'tiled_roof']);
  });
  it('holds no figures, prices, sizes, brands, guarantees or customer details', () => {
    const everything = Object.values(FJC_SCOPE_EXAMPLES).flatMap((ex) => [
      ...ex.specLabels,
      ...ex.headings,
      ...ex.starters.flatMap((g) => [g.heading, ...g.steps]),
      ...ex.sequences.flatMap((s) => [s.label, ...s.sections.flatMap((x) => [x.heading, ...x.steps])]),
    ]);
    expect(everything.length).toBeGreaterThan(40);
    for (const t of everything) {
      expect(t, t).not.toMatch(/\d/);
      expect(t, t).not.toMatch(/[£$€@%]/);
      expect(t, t).not.toMatch(/\b(mm|cm|inch|code|year|years|osb|marley|iko|ludlow|rubbershield|church|road|avenue|street|way)\b/i);
      expect(t, t).not.toMatch(/—|–/);
      expect(t, t).not.toMatch(/\bactually\b/i);
    }
    // Key figure labels are labels only: a guarantee label has no years in it.
    for (const ex of Object.values(FJC_SCOPE_EXAMPLES)) for (const l of ex.specLabels) expect(l).not.toMatch(/\d/);
    for (const ex of Object.values(FJC_SCOPE_EXAMPLES)) expect(ex.intro).not.toMatch(/\d|—/);
  });
  it('a stored value that does not fit is ignored, not trusted', () => {
    expect(parseScopeExamples(null)).toBeNull();
    expect(parseScopeExamples({ nonsense: true })).toBeNull();
    expect(parseScopeExamples(FJC_SCOPE_EXAMPLES.flat_roof)).not.toBeNull();
  });
});
