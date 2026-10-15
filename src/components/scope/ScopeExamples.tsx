'use client';

import { useState } from 'react';
import type { JobTypeOption } from '../../lib/data/quotes';
import { itemsFromSections, makeItem } from '../../lib/scope/items';
import type { ScopeItem } from '../../lib/scope/model';

interface Props {
  types: JobTypeOption[];
  currentTypeId: string;
  hasItems: boolean;
  /** Add these (fresh) items at the end of the steps. */
  onAdd: (items: ScopeItem[]) => void;
}

/** Suggestions drawn from the business's own wording. Nothing is added until it is tapped, and all of it can be edited. */
export function ScopeExamples({ types, currentTypeId, hasItems, onAdd }: Props) {
  const [said, setSaid] = useState('');
  const current = types.find((t) => t.id === currentTypeId);
  const others = types.filter((t) => t.id !== currentTypeId && (t.scopeExamples?.sequences.length ?? 0) > 0);
  const mine = current?.scopeExamples;
  const sequences = [
    ...(mine?.sequences ?? []).map((s) => ({ ...s, from: null as string | null })),
    ...others.flatMap((t) => (t.scopeExamples?.sequences ?? []).map((s) => ({ ...s, from: t.label }))),
  ];
  const starters = mine?.starters ?? [];
  const headings = mine?.headings ?? [];
  if (sequences.length === 0 && starters.length === 0 && headings.length === 0) return null;

  return (
    <div className="sc-examples">
      {sequences.length > 0 ? (
        <div className="sc-ex-block">
          <h3 className="sc-ex-h">Start from an example</h3>
          <p className="hint">A typical order of work. Add it, then change anything you like.</p>
          <ul className="sc-ex-list">
            {sequences.map((s) => (
              <li key={s.key}>
                <span className="sc-ex-name">{s.label}</span>
                <span className="sc-ex-count">{s.sections.reduce((n, x) => n + x.steps.length, 0)} steps</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    onAdd(itemsFromSections(s.sections));
                    setSaid(`Added ${s.label}. Scroll up to change it.`);
                  }}
                >
                  {hasItems ? 'Add to my steps' : 'Use this example'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {headings.length > 0 || starters.length > 0 ? (
        <details className="sc-fold sc-ex-more">
          <summary>
            <span className="sc-fold-title">Single steps and headings</span>
            <span className="sc-fold-meta">Tap to add one</span>
          </summary>
          <div className="sc-fold-body">
      {headings.length > 0 ? (
            <div className="sc-ex-block">
              <h3 className="sc-ex-h">Headings you use</h3>
              <ul className="sc-chips">
                {headings.map((h) => (
                  <li key={h}>
                    <button type="button" className="sc-chip" onClick={() => { onAdd([makeItem('heading', h)]); setSaid(`Added the heading ${h}.`); }}>
                      {h}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {starters.map((g) => (
            <div className="sc-ex-block" key={g.heading}>
              <h3 className="sc-ex-h">{g.heading}</h3>
              <ul className="sc-chips">
                {g.steps.map((st) => (
                  <li key={st}>
                    <button type="button" className="sc-chip" onClick={() => { onAdd([makeItem('step', st)]); setSaid(`Added: ${st}`); }}>
                      {st}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          </div>
        </details>
      ) : null}
      <p className="sc-ex-said" role="status" aria-live="polite">{said}</p>
    </div>
  );
}
