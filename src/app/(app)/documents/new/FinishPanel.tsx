'use client';

import type { QuoteStep } from '../../../../lib/validation/quote';
import type { FixTarget } from './actions';

export type Outcome =
  | { kind: 'idle' }
  | { kind: 'pending'; which: 'preview' | 'later' }
  | { kind: 'saved'; which: 'preview' | 'later'; href: string }
  | {
      kind: 'refused';
      which: 'preview' | 'later';
      /** The draft itself was saved; only the next step was refused. */
      saved: boolean;
      message: string;
      fix?: FixTarget;
      /** Everything the screen already knows is missing, each with a way to it. */
      items?: { key: string; step: QuoteStep; message: string }[];
      diag: string;
    };

const STEP_NAME: Record<QuoteStep, string> = { customer: 'Customer', job: 'Job', scope: 'Scope', price: 'Price', plan: 'Plan', review: 'Review' };

/**
 * The two ways off the review step and, right beside them, what happened. Every press ends in one of: a spinner and
 * "Saving...", "Saved" (then the next page), or exactly why not with a button that goes to the fix.
 */
export function FinishPanel({
  outcome,
  onPreview,
  onLater,
  onFix,
}: {
  outcome: Outcome;
  onPreview: () => void;
  onLater: () => void;
  onFix: (f: Pick<FixTarget, 'step' | 'scopeView'>) => void;
}) {
  const busy = outcome.kind === 'pending' || outcome.kind === 'saved';
  const pendingPreview = outcome.kind === 'pending' && outcome.which === 'preview';
  const pendingLater = outcome.kind === 'pending' && outcome.which === 'later';
  return (
    <div className="qt-finish">
      <div className="qt-finish-live" aria-live="polite" aria-atomic="true">
        {outcome.kind === 'pending' ? <p className="qt-finish-note">{outcome.which === 'preview' ? 'Saving, then opening the preview...' : 'Saving the draft...'}</p> : null}
        {outcome.kind === 'saved' ? (
          <p className="qt-finish-note is-saved">
            <TickIcon /> Saved. {outcome.which === 'preview' ? 'Opening the preview...' : 'Taking you to Home...'}{' '}
            <a href={outcome.href} className="flash-link">Go now</a>
          </p>
        ) : null}
        {outcome.kind === 'refused' ? (
          <div className="qt-finish-msg" role="alert">
            <p className="qt-finish-h">{outcome.saved ? (outcome.which === 'preview' ? 'Not ready to preview yet' : 'Not saved') : 'Not saved'}</p>
            <p>{outcome.message}</p>
            {outcome.items?.length ? (
              <ul className="qt-finish-list">
                {outcome.items.map((i) => (
                  <li key={i.key}>
                    <button type="button" className="linklike" onClick={() => onFix({ step: i.step })}>
                      {STEP_NAME[i.step]}: {i.message}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {outcome.fix ? (
              <button type="button" className="btn btn-secondary qt-finish-fix" onClick={() => onFix(outcome.fix!)}>
                {outcome.fix.label}
              </button>
            ) : null}
            {outcome.saved || !outcome.diag.endsWith('-SCREEN') ? (
              <p className="qt-finish-ref">
                {outcome.saved ? 'Your draft is saved. ' : ''}
                {outcome.diag.endsWith('-SCREEN') ? null : <span className="qt-finish-code">Reference: {outcome.diag}</span>}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="qt-finish-actions">
        <button type="button" className="btn btn-primary" onClick={onPreview} disabled={busy} aria-busy={pendingPreview || undefined}>
          {pendingPreview ? (
            <>
              <span className="qt-spin" aria-hidden="true" /> Saving...
            </>
          ) : (
            'Preview the document'
          )}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onLater} disabled={busy} aria-busy={pendingLater || undefined}>
          {pendingLater ? (
            <>
              <span className="qt-spin" aria-hidden="true" /> Saving...
            </>
          ) : (
            'Save and come back later'
          )}
        </button>
      </div>
    </div>
  );
}

function TickIcon() {
  return (
    <svg className="qt-finish-tick" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
