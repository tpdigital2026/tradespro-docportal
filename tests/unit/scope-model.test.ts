import { describe, expect, it } from 'vitest';
import {
  cleanCopySections,
  cleanLine,
  copyErrors,
  countSteps,
  emptyScope,
  groupItems,
  isApproved,
  isStale,
  scopeErrors,
  scopeFormSchema,
  scopeKey,
  SCOPE_LIMITS,
  type ScopeFormValues,
  type ScopeItem,
} from '../../src/lib/scope/model';
import { approvedScope, STEPS } from '../fixtures/scope';

const step = (text: string, id = `s${Math.random().toString(36).slice(2, 8)}`): ScopeItem => ({ id, kind: 'step', text });
const head = (text: string, id = `h${Math.random().toString(36).slice(2, 8)}`): ScopeItem => ({ id, kind: 'heading', text });

describe('groupItems', () => {
  it('groups steps under their headings and keeps leading steps in a group with no heading', () => {
    const g = groupItems([step('a'), head('H1'), step('b'), step('c'), head('H2'), step('d')]);
    expect(g).toEqual([
      { heading: null, steps: ['a'] },
      { heading: 'H1', steps: ['b', 'c'] },
      { heading: 'H2', steps: ['d'] },
    ]);
  });
  it('ignores blank boxes and cleans spaces and list markers', () => {
    expect(groupItems([step('   '), step('  - strip   off  the roof '), step('1. fit it')])).toEqual([{ heading: null, steps: ['strip off the roof', 'fit it'] }]);
    expect(countSteps([step(''), head('x'), step('y')])).toBe(1);
  });
});

describe('scopeKey and approval', () => {
  it('ignores ids and blank boxes, notices order, wording and kind', () => {
    const a = [head('A', 'x1'), step('one', 'x2')];
    const b = [head('A', 'y1'), step('', 'y9'), step('one', 'y2')];
    expect(scopeKey(a)).toBe(scopeKey(b));
    expect(scopeKey([step('one'), step('two')])).not.toBe(scopeKey([step('two'), step('one')]));
    expect(scopeKey([step('one')])).not.toBe(scopeKey([step('one!')]));
    expect(scopeKey([head('one')])).not.toBe(scopeKey([step('one')]));
  });
  it('approved only while the copy was made from exactly these steps', () => {
    const s = approvedScope();
    expect(isApproved(s)).toBe(true);
    expect(isStale(s)).toBe(false);
    const edited = { ...s, items: s.items.map((i) => (i.id === 's2' ? { ...i, text: 'Take all waste away today.' } : i)) };
    expect(isApproved(edited)).toBe(false);
    expect(isStale(edited)).toBe(true);
  });
  it('a blank box added or removed does not take the approval away', () => {
    const s = approvedScope();
    expect(isApproved({ ...s, items: [...s.items, step('  ')] })).toBe(true);
  });
  it('not approved without a time, without copy, or with nothing to read', () => {
    const s = approvedScope();
    expect(isApproved({ ...s, copy: { ...s.copy!, approvedAt: null } })).toBe(false);
    expect(isApproved({ ...s, copy: null })).toBe(false);
    expect(isApproved({ ...s, copy: { ...s.copy!, sections: [{ heading: 'x', steps: ['  '] }] } })).toBe(false);
  });
});

describe('scopeErrors', () => {
  it('a draft only complains about length', () => {
    expect(scopeErrors(emptyScope(), 'draft')).toEqual({});
    const e = scopeErrors({ ...emptyScope(), coverTitle: 'x'.repeat(121), intro: 'y'.repeat(1201) }, 'draft');
    expect(Object.keys(e).sort()).toEqual(['scope.coverTitle', 'scope.intro']);
  });
  it('final needs a title, a step and approval', () => {
    const e = scopeErrors(emptyScope(), 'final');
    expect(e['scope.coverTitle']).toBeDefined();
    expect(e['scope.items']).toBe('Add at least one step');
    expect(e['scope.approval']).toBeUndefined();
    const e2 = scopeErrors({ ...emptyScope(), coverTitle: 'T', items: STEPS }, 'final');
    expect(e2['scope.approval']).toContain('approve');
    expect(scopeErrors(approvedScope(), 'final')).toEqual({});
  });
  it('says so when the steps changed after the copy was made', () => {
    const s = approvedScope();
    const e = scopeErrors({ ...s, items: [...s.items, step('One more thing')] }, 'final');
    expect(e['scope.approval']).toContain('changed the steps');
  });
  it('key figures: both halves or neither', () => {
    const s = approvedScope({ specCards: [{ value: '', label: 'Roof area' }, { value: '24', label: '' }, { value: '', label: '' }] });
    const e = scopeErrors(s, 'final');
    expect(e['scope.specCards.0.value']).toBeDefined();
    expect(e['scope.specCards.1.label']).toBeDefined();
    expect(e['scope.specCards.2.value']).toBeUndefined();
    expect(scopeErrors(s, 'draft')).toEqual({});
  });
  it('enforces the limits: 12 headings, 30 steps a heading, 40 characters on a key figure', () => {
    const many = Array.from({ length: 13 }, (_, i) => [head(`H${i}`), step(`s${i}`)]).flat();
    expect(scopeErrors({ ...emptyScope(), items: many }, 'draft')['scope.items']).toContain('12');
    const long = [head('H'), ...Array.from({ length: 31 }, (_, i) => step(`s${i}`))];
    expect(scopeErrors({ ...emptyScope(), items: long }, 'draft')['scope.items']).toContain('30');
    const e = scopeErrors({ ...emptyScope(), specCards: [{ value: 'v'.repeat(41), label: 'l'.repeat(41) }] }, 'draft');
    expect(e['scope.specCards.0.value']).toBeDefined();
    expect(e['scope.specCards.0.label']).toBeDefined();
  });
});

describe('the schema (what the browser may send)', () => {
  const ok = (v: unknown) => scopeFormSchema.safeParse(v).success;
  const base = (): ScopeFormValues => ({ ...emptyScope(), items: [{ id: 'a1', kind: 'step', text: 'Do it.' }] });
  it('accepts a normal scope', () => {
    expect(ok(base())).toBe(true);
    expect(ok(approvedScope())).toBe(true);
  });
  it('rejects control characters, over-long text and bad ids', () => {
    expect(ok({ ...base(), items: [{ id: 'a1', kind: 'step', text: 'a\u0000b' }] })).toBe(false);
    expect(ok({ ...base(), items: [{ id: 'a1', kind: 'step', text: 'a\nb' }] })).toBe(false);
    expect(ok({ ...base(), items: [{ id: 'a1', kind: 'step', text: 'x'.repeat(301) }] })).toBe(false);
    expect(ok({ ...base(), items: [{ id: 'a1', kind: 'heading', text: 'x'.repeat(81) }] })).toBe(false);
    expect(ok({ ...base(), items: [{ id: 'a b', kind: 'step', text: 'x' }] })).toBe(false);
    expect(ok({ ...base(), items: [{ id: 'a1', kind: 'other', text: 'x' }] })).toBe(false);
    expect(ok({ ...base(), intro: 'x'.repeat(1201) })).toBe(false);
    expect(ok({ ...base(), intro: 'two\nlines' })).toBe(true);
    expect(ok({ ...base(), intro: 'bad\u0007' })).toBe(false);
    expect(ok({ ...base(), specCards: Array.from({ length: 5 }, () => ({ value: 'v', label: 'l' })) })).toBe(false);
    expect(ok({ ...base(), items: Array.from({ length: SCOPE_LIMITS.items + 1 }, (_, i) => ({ id: `i${i}`, kind: 'step', text: 'x' })) })).toBe(false);
  });
  it('drops anything it does not know about', () => {
    const r = scopeFormSchema.safeParse({ ...base(), extra: 1 });
    expect(r.success && 'extra' in r.data).toBe(false);
  });
});

describe('copy', () => {
  it('copyErrors flags blank wording, blank headings and over-long lines', () => {
    const c = approvedScope().copy!;
    expect(copyErrors(c)).toEqual({});
    expect(copyErrors({ ...c, sections: [{ heading: 'H', steps: ['  '] }] })['scope.copy']).toBeDefined();
    expect(copyErrors({ ...c, sections: [{ heading: ' ', steps: ['Do it.'] }] })['scope.copy.0']).toBeDefined();
    expect(copyErrors({ ...c, sections: [{ heading: 'H', steps: ['x'.repeat(301)] }] })['scope.copy.0']).toBeDefined();
  });
  it('cleanCopySections drops blanks and empty groups', () => {
    expect(cleanCopySections([{ heading: ' A ', steps: [' x ', ''] }, { heading: 'B', steps: ['  '] }])).toEqual([{ heading: 'A', steps: ['x'] }]);
  });
});

describe('fuzz: validation never throws, and the key is stable', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const words = ['strip', 'off', 'roof', '  ', '', '1. ', '- ', 'Fit', '\u0000', 'x'.repeat(320), 'felt', '£500'];
  const text = () => Array.from({ length: Math.floor(rnd() * 5) }, () => words[Math.floor(rnd() * words.length)]).join(' ');
  it('1000 random scopes', () => {
    for (let n = 0; n < 1000; n++) {
      const items: ScopeItem[] = Array.from({ length: Math.floor(rnd() * 20) }, (_, i) => ({ id: `i${i}`, kind: rnd() < 0.2 ? 'heading' : 'step', text: text() }));
      const scope: ScopeFormValues = { ...emptyScope(), coverTitle: text(), items };
      expect(() => scopeErrors(scope, 'final')).not.toThrow();
      expect(scopeKey(items)).toBe(scopeKey(items.map((i) => ({ ...i, id: `z${i.id}` }))));
      const cleaned = groupItems(items).flatMap((g) => [g.heading ?? '', ...g.steps]);
      for (const c of cleaned) expect(c).toBe(cleanLine(c));
    }
  });
});
