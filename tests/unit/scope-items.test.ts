import { describe, expect, it } from 'vitest';
import { addAfter, canMove, insertAfter, itemsFromSections, joinSpoken, makeItem, move, newId, remove, setText, splitPaste } from '../../src/lib/scope/items';
import type { ScopeItem } from '../../src/lib/scope/model';

const mk = (spec: string): ScopeItem[] => spec.split(' ').map((t) => ({ id: t, kind: t[0] === 'H' ? 'heading' : 'step', text: t }));
const ids = (items: ScopeItem[]) => items.map((i) => i.id).join(' ');

describe('adding, editing, removing', () => {
  it('adds after an item, at the end, or at the end when the id is unknown', () => {
    const base = mk('a b c');
    expect(ids(addAfter(base, 'a', 'step').items.map((i) => ({ ...i, id: i.text === '' ? 'NEW' : i.id })))).toBe('a NEW b c');
    expect(addAfter(base, null, 'heading').items.at(-1)?.kind).toBe('heading');
    expect(addAfter(base, 'nope', 'step').items).toHaveLength(4);
    expect(ids(insertAfter(base, 'c', makeItem('step', 'z')).slice(0, 3))).toBe('a b c');
  });
  it('ids are unique', () => {
    expect(new Set(Array.from({ length: 500 }, newId)).size).toBe(500);
  });
  it('sets text and removes without touching the rest', () => {
    const base = mk('a b c');
    expect(setText(base, 'b', 'hello').map((i) => i.text)).toEqual(['a', 'hello', 'c']);
    expect(ids(remove(base, 'b'))).toBe('a c');
  });
});

describe('moving', () => {
  it('moves a step one place and stops at the ends', () => {
    const base = mk('a b c');
    expect(ids(move(base, 'b', -1))).toBe('b a c');
    expect(ids(move(base, 'b', 1))).toBe('a c b');
    expect(canMove(base, 'a', -1)).toBe(false);
    expect(canMove(base, 'c', 1)).toBe(false);
    expect(ids(move(base, 'a', -1))).toBe('a b c');
  });
  it('a step moving past a heading joins the other group', () => {
    expect(ids(move(mk('H1 a H2 b'), 'b', -1))).toBe('H1 a b H2');
    expect(ids(move(mk('H1 a H2 b'), 'a', 1))).toBe('H1 H2 a b');
  });
  it('a heading moves with its steps, as a group', () => {
    expect(ids(move(mk('H1 a b H2 c'), 'H2', -1))).toBe('H2 c H1 a b');
    expect(ids(move(mk('H1 a b H2 c'), 'H1', 1))).toBe('H2 c H1 a b');
    expect(canMove(mk('H1 a b H2 c'), 'H2', 1)).toBe(false);
    expect(canMove(mk('H1 a b H2 c'), 'H1', -1)).toBe(false);
  });
  it('a heading jumps over leading steps that have no heading', () => {
    expect(ids(move(mk('x y H1 a'), 'H1', -1))).toBe('H1 a x y');
  });
  it('moving and moving back is the identity, and nothing is lost (400 random lists)', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let n = 0; n < 400; n++) {
      const items: ScopeItem[] = Array.from({ length: 1 + Math.floor(rnd() * 10) }, (_, i) => ({ id: `i${i}`, kind: i === 0 || rnd() < 0.25 ? 'heading' : 'step', text: `t${i}` }));
      const pick = items[Math.floor(rnd() * items.length)]!;
      const dir = rnd() < 0.5 ? -1 : 1;
      const once = move(items, pick.id, dir);
      expect([...once].map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
      if (canMove(items, pick.id, dir)) {
        // Lists start with a heading here, so a moved heading always comes back exactly. A step that jumps a heading changes group.
        const back = move(once, pick.id, dir === -1 ? 1 : -1);
        if (pick.kind === 'heading') expect(ids(back)).toBe(ids(items));
      }
    }
  });
});

describe('pasting and speaking', () => {
  it('splits pasted lines into steps and drops markers, numbers and blank lines', () => {
    expect(splitPaste('- Strip off\n\n2. Fit new felt\r\n• Clear up  the site\n')).toEqual(['Strip off', 'Fit new felt', 'Clear up the site']);
    expect(splitPaste('   \n  ')).toEqual([]);
    expect(splitPaste('x'.repeat(400))[0]).toHaveLength(300);
  });
  it('joins spoken words after what is there, with one space, within the limit', () => {
    expect(joinSpoken('', ' remove the old felt ')).toBe('remove the old felt');
    expect(joinSpoken('Remove the felt', ' and the decking')).toBe('Remove the felt and the decking');
    expect(joinSpoken('Keep this  ', '')).toBe('Keep this  ');
    expect(joinSpoken('a', 'b'.repeat(400))).toHaveLength(300);
  });
  it('builds fresh items from example sections', () => {
    const items = itemsFromSections([{ heading: 'H', steps: ['a', 'b'] }]);
    expect(items.map((i) => [i.kind, i.text])).toEqual([['heading', 'H'], ['step', 'a'], ['step', 'b']]);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
  });
});
