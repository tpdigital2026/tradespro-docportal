import { SCOPE_LIMITS, type CopySection, type ScopeItem, type ScopeItemKind } from './model';

/** Pure edits to the ordered list of steps and headings, so the screen stays thin and these can be tested. */

let counter = 0;
export function newId(): string {
  counter += 1;
  return `i${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const makeItem = (kind: ScopeItemKind, text = ''): ScopeItem => ({ id: newId(), kind, text });

/** Put an item after the one with this id, or at the end when id is null or not found. */
export function insertAfter(items: readonly ScopeItem[], afterId: string | null, item: ScopeItem): ScopeItem[] {
  let at = items.length;
  if (afterId !== null) {
    const i = items.findIndex((x) => x.id === afterId);
    if (i >= 0) at = i + 1;
  }
  const next = [...items];
  next.splice(at, 0, item);
  return next;
}

/** Insert a new empty (or given) item after the one with this id. Returns the new list and the new item. */
export function addAfter(items: readonly ScopeItem[], afterId: string | null, kind: ScopeItemKind, text = ''): { items: ScopeItem[]; added: ScopeItem } {
  const added = makeItem(kind, text);
  return { items: insertAfter(items, afterId, added), added };
}

export function setText(items: readonly ScopeItem[], id: string, text: string): ScopeItem[] {
  return items.map((i) => (i.id === id ? { ...i, text } : i));
}

export function remove(items: readonly ScopeItem[], id: string): ScopeItem[] {
  return items.filter((i) => i.id !== id);
}

/** The range [from, to) an item moves as: a step alone, a heading with all the steps under it. */
function block(items: readonly ScopeItem[], index: number): [number, number] {
  const it = items[index]!;
  if (it.kind !== 'heading') return [index, index + 1];
  let end = index + 1;
  while (end < items.length && items[end]!.kind !== 'heading') end += 1;
  return [index, end];
}

/** Start of the block just before `index` (a heading's group, or the previous single step). */
function prevBlockStart(items: readonly ScopeItem[], index: number): number {
  const prev = index - 1;
  if (prev < 0) return -1;
  if (items[index]!.kind !== 'heading') return prev;
  // Moving a group: jump over the whole previous group, headingless leading steps included.
  let start = prev;
  while (start > 0 && items[start]!.kind !== 'heading') start -= 1;
  return start;
}

export function canMove(items: readonly ScopeItem[], id: string, dir: -1 | 1): boolean {
  const index = items.findIndex((i) => i.id === id);
  if (index < 0) return false;
  if (dir === -1) return prevBlockStart(items, index) >= 0;
  return block(items, index)[1] < items.length;
}

/** Move a step one place, or a heading together with its steps one group. Unchanged when it cannot move. */
export function move(items: readonly ScopeItem[], id: string, dir: -1 | 1): ScopeItem[] {
  const index = items.findIndex((i) => i.id === id);
  if (index < 0 || !canMove(items, id, dir)) return [...items];
  const [from, to] = block(items, index);
  const moving = items.slice(from, to);
  if (dir === -1) {
    const start = prevBlockStart(items, index);
    return [...items.slice(0, start), ...moving, ...items.slice(start, from), ...items.slice(to)];
  }
  const nextEnd = items[index]!.kind === 'heading' ? block(items, to)[1] : to + 1;
  return [...items.slice(0, from), ...items.slice(to, nextEnd), ...moving, ...items.slice(nextEnd)];
}

/** Lines pasted into a box become separate steps. List markers and blank lines are dropped. */
export function splitPaste(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/^\s*(?:[-*•–—]+|\(?\d{1,3}[.)])\s+/, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .map((l) => l.slice(0, SCOPE_LIMITS.step));
}

/** Fresh items for an example or a group of starters: a heading then its steps. Nothing typed is touched. */
export function itemsFromSections(sections: readonly CopySection[]): ScopeItem[] {
  const out: ScopeItem[] = [];
  for (const s of sections) {
    out.push(makeItem('heading', s.heading));
    for (const st of s.steps) out.push(makeItem('step', st));
  }
  return out;
}

/** Where a spoken phrase goes: after what is already in the box, with one space between. */
export function joinSpoken(base: string, spoken: string, max: number = SCOPE_LIMITS.step): string {
  const said = spoken.replace(/\s+/g, ' ').trim();
  if (said === '') return base;
  const b = base.replace(/\s+$/, '');
  return `${b}${b === '' ? '' : ' '}${said}`.slice(0, max);
}
