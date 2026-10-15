'use client';

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { canMove, insertAfter, makeItem, move, remove, setText, splitPaste } from '../../lib/scope/items';
import { SCOPE_LIMITS, type ScopeItem } from '../../lib/scope/model';
import { AutoTextarea, Counter } from './bits';
import { ChevronIcon, DownIcon, MicIcon, PlusIcon, TrashIcon, UpIcon } from './icons';
import { useDictation } from './useDictation';

interface Props {
  items: ScopeItem[];
  /** Apply a change to the list. Takes a function so quick edits (dictation, paste) never overwrite each other. */
  update: (fn: (items: ScopeItem[]) => ScopeItem[]) => void;
  errors: Record<string, string>;
}

export function ScopeSteps({ items, update, errors }: Props) {
  const { supported, active, problem, start, stop } = useDictation();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [announce, setAnnounce] = useState('');
  const pending = useRef<{ id: string; part: 'text' | 'up' | 'down' } | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const focusNow = useCallback((id: string, part: 'text' | 'up' | 'down' = 'text') => {
    const el = document.querySelector<HTMLElement>(`[data-sc="${id}-${part}"]`);
    el?.focus();
  }, []);

  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    focusNow(p.id, p.part);
  });

  const add = (kind: 'step' | 'heading', afterId: string | null) => {
    const added = makeItem(kind);
    pending.current = { id: added.id, part: 'text' };
    update((cur) => insertAfter(cur, afterId, added));
  };

  const moveItem = (it: ScopeItem, dir: -1 | 1) => {
    const list = itemsRef.current;
    if (!canMove(list, it.id, dir)) return;
    const after = move(list, it.id, dir);
    const stepsOnly = after.filter((x) => x.kind === 'step');
    const label = it.kind === 'heading' ? `Moved the heading ${dir === -1 ? 'up' : 'down'}.` : `Moved to step ${stepsOnly.findIndex((x) => x.id === it.id) + 1} of ${stepsOnly.length}.`;
    setAnnounce(label);
    // A step that lands under a folded heading would vanish with the focus on it: open that group.
    if (it.kind === 'step') {
      let owner: string | null = null;
      for (const x of after) {
        if (x.kind === 'heading') owner = x.id;
        if (x.id === it.id) break;
      }
      if (owner) setCollapsed((c) => (c.has(owner!) ? new Set([...c].filter((id) => id !== owner)) : c));
    }
    pending.current = { id: it.id, part: dir === -1 ? 'up' : 'down' };
    update((cur) => move(cur, it.id, dir));
  };

  const del = (it: ScopeItem, index: number) => {
    const list = itemsRef.current;
    const neighbour = list[index + 1] ?? list[index - 1];
    if (neighbour) pending.current = { id: neighbour.id, part: 'text' };
    setAnnounce(it.kind === 'heading' ? 'Heading removed.' : 'Step removed.');
    update((cur) => remove(cur, it.id));
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>, it: ScopeItem) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (it.text.trim() === '') return;
    add('step', it.id);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>, it: ScopeItem) => {
    const text = e.clipboardData.getData('text');
    if (!/[\r\n]/.test(text)) return;
    const lines = splitPaste(text);
    if (lines.length === 0) return;
    e.preventDefault();
    const fresh = lines.slice(it.text.trim() === '' ? 1 : 0).map((l) => makeItem('step', l));
    const first = it.text.trim() === '' ? lines[0]! : null;
    const last = fresh[fresh.length - 1];
    if (last) pending.current = { id: last.id, part: 'text' };
    update((cur) => {
      const base = first !== null ? setText(cur, it.id, first) : cur;
      const at = base.findIndex((x) => x.id === it.id) + 1;
      return [...base.slice(0, at), ...fresh, ...base.slice(at)];
    });
    setAnnounce(`${lines.length} ${lines.length === 1 ? 'step' : 'steps'} added from what you pasted.`);
  };

  const mic = (it: ScopeItem) => {
    if (active === it.id) {
      stop();
      return;
    }
    const max = it.kind === 'heading' ? SCOPE_LIMITS.heading : SCOPE_LIMITS.step;
    start(it.id, it.text, (text) => update((cur) => setText(cur, it.id, text)), max);
  };

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  let stepNo = 0;
  let hidden = false;
  let inGroup = false;
  return (
    <div className="sc-steps">
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      {problem ? <p className="sc-problem" role="status">{problem}</p> : null}
      {!supported && items.length > 0 ? <p className="hint sc-tip">Tip: tap the microphone on your keyboard to speak a step instead of typing it.</p> : null}
      <ol className="sc-list" aria-label="Steps of the work, in order">
        {items.map((it, index) => {
          if (it.kind === 'heading') {
            hidden = collapsed.has(it.id);
            inGroup = true;
          } else if (hidden) {
            stepNo += 1;
            return null;
          }
          const err = errors[`scope.item.${it.id}`];
          const isHeading = it.kind === 'heading';
          if (!isHeading) stepNo += 1;
          const max = isHeading ? SCOPE_LIMITS.heading : SCOPE_LIMITS.step;
          const inputId = `sc-${it.id}`;
          const label = isHeading ? 'Heading' : `Step ${stepNo}`;
          const listening = active === it.id;
          const common = {
            id: inputId,
            'data-sc': `${it.id}-text`,
            value: it.text,
            maxLength: max,
            'aria-invalid': err ? true : undefined,
            'aria-describedby': [`${inputId}-n`, err ? `${inputId}-e` : ''].filter(Boolean).join(' '),
            autoComplete: 'off',
            className: 'input',
          } as const;
          return (
            <li key={it.id} className={`sc-item ${isHeading ? 'is-heading' : 'is-step'}${!isHeading && inGroup ? ' is-grouped' : ''}${listening ? ' is-listening' : ''}`}>
              <div className="sc-item-head">
                {isHeading ? (
                  <button type="button" className="sc-fold-btn" aria-expanded={!collapsed.has(it.id)} aria-label={`${collapsed.has(it.id) ? 'Show' : 'Hide'} the steps under this heading`} onClick={() => toggle(it.id)}>
                    <ChevronIcon />
                  </button>
                ) : null}
                <label htmlFor={inputId} className="sc-item-label">{label}</label>
                <Counter id={`${inputId}-n`} length={it.text.length} max={max} />
              </div>
              {isHeading ? (
                <input {...common} type="text" placeholder="For example, Preparation" onChange={(e) => update((cur) => setText(cur, it.id, e.target.value))} onPaste={(e) => onPaste(e, it)} />
              ) : (
                <AutoTextarea
                  {...common}
                  placeholder="One thing you will do, in a sentence"
                  onChange={(e) => update((cur) => setText(cur, it.id, e.target.value.replace(/[\r\n]+/g, ' ')))}
                  onKeyDown={(e) => onKey(e, it)}
                  onPaste={(e) => onPaste(e, it)}
                />
              )}
              {err ? <p className="error" id={`${inputId}-e`}>{err}</p> : null}
              <div className="sc-tools">
                {supported ? (
                  <button type="button" className={`btn btn-secondary sc-mic${listening ? ' is-on' : ''}`} aria-pressed={listening} onClick={() => mic(it)}>
                    <MicIcon />
                    <span>{listening ? 'Listening. Tap to stop' : 'Speak'}</span>
                    <span className="sr-only">{isHeading ? ' this heading' : ` step ${stepNo}`}</span>
                  </button>
                ) : null}
                <span className="sc-tools-end">
                  <button type="button" className="sc-icon-btn" data-sc={`${it.id}-up`} aria-label={isHeading ? 'Move this heading and its steps up' : `Move step ${stepNo} up`} disabled={!canMove(items, it.id, -1)} onClick={() => moveItem(it, -1)}>
                    <UpIcon />
                  </button>
                  <button type="button" className="sc-icon-btn" data-sc={`${it.id}-down`} aria-label={isHeading ? 'Move this heading and its steps down' : `Move step ${stepNo} down`} disabled={!canMove(items, it.id, 1)} onClick={() => moveItem(it, 1)}>
                    <DownIcon />
                  </button>
                  <button type="button" className="sc-icon-btn" aria-label={isHeading ? 'Remove this heading' : `Remove step ${stepNo}`} onClick={() => del(it, index)}>
                    <TrashIcon />
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="sc-add">
        <button type="button" className="btn btn-secondary" onClick={() => add('step', items.length ? items[items.length - 1]!.id : null)}>
          <PlusIcon />
          Add a step
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => add('heading', items.length ? items[items.length - 1]!.id : null)}>
          <PlusIcon />
          Add a heading
        </button>
      </div>
    </div>
  );
}
