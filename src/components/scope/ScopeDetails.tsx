'use client';

import { useRef } from 'react';
import type { JobTypeOption } from '../../lib/data/quotes';
import { SCOPE_LIMITS, type ScopeFormValues, type SpecCardValue } from '../../lib/scope/model';
import { Field } from '../Field';
import { Counter } from './bits';
import { PlusIcon, TrashIcon } from './icons';

interface Props {
  scope: ScopeFormValues;
  patch: (p: Partial<ScopeFormValues>) => void;
  err: (key: string) => string | undefined;
  touch: (key: string) => void;
  type: JobTypeOption | undefined;
}

/** Cover, key figures and the note. Quiet folds under the steps; the owner types every figure. */
export function ScopeDetails({ scope, patch, err, touch, type }: Props) {
  const cardRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const cards = scope.specCards;
  const setCard = (i: number, p: Partial<SpecCardValue>) => patch({ specCards: cards.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const labels = (type?.scopeExamples?.specLabels ?? []).filter((l) => !cards.some((c) => c.label.trim().toLowerCase() === l.toLowerCase()));
  const full = cards.length >= SCOPE_LIMITS.specCards;

  const addCard = (label = '') => {
    if (full) return;
    patch({ specCards: [...cards, { value: '', label }] });
    const at = cards.length;
    setTimeout(() => cardRefs.current[at]?.focus(), 0);
  };
  const useLabel = (label: string) => {
    const blank = cards.findIndex((c) => c.label.trim() === '');
    if (blank >= 0) {
      setCard(blank, { label });
      setTimeout(() => cardRefs.current[blank]?.focus(), 0);
    } else addCard(label);
  };

  return (
    <div className="sc-folds">
      <details className="sc-fold">
        <summary>
          <span className="sc-fold-title">Cover and introduction</span>
          <span className="sc-fold-meta">{scope.coverTitle.trim() || 'Not set'}</span>
        </summary>
        <div className="sc-fold-body">
          <Field announce={false} id="sc-title" label="Title of the quote" value={scope.coverTitle} maxLength={SCOPE_LIMITS.coverTitle} onChange={(e) => patch({ coverTitle: e.target.value })} onBlur={() => touch('scope.coverTitle')} error={err('scope.coverTitle')} autoComplete="off" />
          <Field announce={false} id="sc-sub" label="Line under the title" hint="Optional." value={scope.coverSub} maxLength={SCOPE_LIMITS.coverSub} onChange={(e) => patch({ coverSub: e.target.value })} error={err('scope.coverSub')} autoComplete="off" />
          <div className="sc-count-wrap">
            <Field announce={false} id="sc-intro" multiline label="Introduction" hint="A few lines at the start. It comes from your own wording, so change it as you like." value={scope.intro} maxLength={SCOPE_LIMITS.intro} rows={5} onChange={(e) => patch({ intro: e.target.value })} error={err('scope.intro')} />
            <Counter id="sc-intro-n" length={scope.intro.length} max={SCOPE_LIMITS.intro} />
          </div>
        </div>
      </details>

      <details className="sc-fold">
        <summary>
          <span className="sc-fold-title">Key figures</span>
          <span className="sc-fold-meta">{cards.length === 0 ? 'Optional' : `${cards.length} of ${SCOPE_LIMITS.specCards}`}</span>
        </summary>
        <div className="sc-fold-body">
          <p className="hint">Up to {SCOPE_LIMITS.specCards} short facts shown big on the quote, like the area or the system. You type every figure.</p>
          {cards.length > 0 ? (
            <ul className="sc-cards">
              {cards.map((c, i) => (
                <li key={i} className="sc-card-row">
                  <Field announce={false} id={`sc-card-v-${i}`} ref={(el) => { cardRefs.current[i] = el; }} label={`Figure ${i + 1}`} value={c.value} maxLength={SCOPE_LIMITS.specValue} onChange={(e) => setCard(i, { value: e.target.value })} error={err(`scope.specCards.${i}.value`)} autoComplete="off" />
                  <Field announce={false} id={`sc-card-l-${i}`} label="What it is" value={c.label} maxLength={SCOPE_LIMITS.specLabel} onChange={(e) => setCard(i, { label: e.target.value })} error={err(`scope.specCards.${i}.label`)} autoComplete="off" />
                  <button type="button" className="sc-icon-btn" aria-label={`Remove figure ${i + 1}`} onClick={() => patch({ specCards: cards.filter((_, j) => j !== i) })}>
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {labels.length > 0 && !full ? (
            <div>
              <p className="sc-ex-h">Labels you use</p>
              <ul className="sc-chips">
                {labels.map((l) => (
                  <li key={l}>
                    <button type="button" className="sc-chip" onClick={() => useLabel(l)}>{l}</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <button type="button" className="btn btn-secondary sc-add-one" disabled={full} onClick={() => addCard()}>
            <PlusIcon />
            Add a figure
          </button>
        </div>
      </details>

      <details className="sc-fold">
        <summary>
          <span className="sc-fold-title">Please note box</span>
          <span className="sc-fold-meta">{scope.note.trim() ? 'Written' : 'Optional'}</span>
        </summary>
        <div className="sc-fold-body">
          <div className="sc-count-wrap">
            <Field announce={false} id="sc-note" multiline label="What the customer should know" hint="Things that are not included, or that you are assuming. It shows in a highlighted box." value={scope.note} maxLength={SCOPE_LIMITS.note} rows={4} onChange={(e) => patch({ note: e.target.value })} error={err('scope.note')} />
            <Counter id="sc-note-n" length={scope.note.length} max={SCOPE_LIMITS.note} />
          </div>
        </div>
      </details>
    </div>
  );
}
