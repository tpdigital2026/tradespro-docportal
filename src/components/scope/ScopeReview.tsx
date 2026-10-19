'use client';

import { AutoTextarea } from './bits';
import { groupItems, SCOPE_LIMITS, wordingEdited, type ScopeCopy, type ScopeItem } from '../../lib/scope/model';

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

interface Props {
  items: ScopeItem[];
  copy: ScopeCopy;
  notice: string | null;
  approved: boolean;
  /** Change the wording. Any change takes the approval away. */
  editCopy: (fn: (c: ScopeCopy) => ScopeCopy) => void;
  errors: Record<string, string>;
  /** "Add a step" on a suggestion: adds it to the owner's steps (the wording then has to be made again). */
  onAddStep?: (text: string) => void;
}

/** The time of approval for the screen. A value that is not a real date shows nothing rather than breaking the page. */
export function approvedTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : clock.format(d);
}

export function engineLine(copy: ScopeCopy): string {
  return copy.engine === 'ai'
    ? 'Tidied by the AI assistant. It was told to keep your meaning and add nothing.'
    : 'Basic tidy, no AI used. Only capital letters, full stops and repeated steps were changed. Your words are as you wrote them.';
}

/** Their steps beside the tidied wording. Everything on the right can be edited. */
export function ScopeReview({ items, copy, notice, approved, editCopy, errors, onAddStep }: Props) {
  const suggestions = copy.suggestions ?? [];
  const groups = groupItems(items);
  const edited = wordingEdited(copy);
  let n = 0;
  return (
    <div className="sc-review">
      <p className="sc-engine">{engineLine(copy)}</p>
      {notice ? <p className="sc-notice" role="status">{notice}</p> : null}
      {approved && copy.approvedAt ? (
        <p className="sc-approved" role="status">
          {approvedTime(copy.approvedAt) ? `Approved at ${approvedTime(copy.approvedAt)}.` : 'Approved.'} This is the wording the customer will read.
          {edited ? ' It includes changes you made yourself after it was generated.' : null}
        </p>
      ) : null}
      {edited ? (
        <p className="sc-edited" role="note">
          <span className="sc-edited-tag">Edited by you</span>
          You changed some of the wording after it was made. Your own changes are not checked by the assistant, so read them through before you approve.
        </p>
      ) : null}

      <div className="sc-review-grid">
        <section className="sc-orig" aria-labelledby="sc-orig-h">
          <h3 id="sc-orig-h" className="qt-h3">What you wrote</h3>
          {groups.map((g, gi) => (
            <div key={gi} className="sc-orig-group">
              {g.heading ? <p className="sc-orig-head">{g.heading}</p> : null}
              <ol className="sc-orig-list" start={n + 1}>
                {g.steps.map((s, si) => {
                  n += 1;
                  return <li key={si} value={n}>{s}</li>;
                })}
              </ol>
            </div>
          ))}
        </section>

        <section className="sc-new" aria-labelledby="sc-new-h">
          <h3 id="sc-new-h" className="qt-h3">What the customer will read</h3>
          {copy.uncertain.length > 0 ? (
            <div className="sc-check">
              <p className="sc-check-h">Please check these</p>
              <ul>
                {copy.uncertain.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {copy.sections.map((s, si) => {
            const err = errors[`scope.copy.${si}`];
            return (
              <div key={si} className="sc-new-sec">
                <label className="sc-new-label" htmlFor={`sc-h-${si}`}>Heading</label>
                <input
                  id={`sc-h-${si}`}
                  className="input sc-new-head"
                  value={s.heading}
                  maxLength={SCOPE_LIMITS.heading}
                  autoComplete="off"
                  onChange={(e) => editCopy((c) => ({ ...c, sections: c.sections.map((x, j) => (j === si ? { ...x, heading: e.target.value } : x)) }))}
                />
                <ul className="sc-new-steps">
                  {s.steps.map((b, bi) => (
                    <li key={bi}>
                      <label className="sr-only" htmlFor={`sc-b-${si}-${bi}`}>{`${s.heading || 'Group'}, line ${bi + 1}`}</label>
                      <AutoTextarea
                        id={`sc-b-${si}-${bi}`}
                        className="input"
                        value={b}
                        maxLength={SCOPE_LIMITS.step}
                        onChange={(e) =>
                          editCopy((c) => ({
                            ...c,
                            sections: c.sections.map((x, j) => (j === si ? { ...x, steps: x.steps.map((y, k) => (k === bi ? e.target.value.replace(/[\r\n]+/g, ' ') : y)) } : x)),
                          }))
                        }
                      />
                    </li>
                  ))}
                </ul>
                {err ? <p className="error">{err}</p> : null}
              </div>
            );
          })}
          {copy.corrections.length > 0 ? (
            <div className="sc-changed">
              <p className="sc-check-h">What was changed</p>
              <ul>
                {copy.corrections.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="hint">Nothing needed changing.</p>
          )}
        </section>
      </div>

      {suggestions.length > 0 && onAddStep ? (
        <section className="sc-suggest" aria-labelledby="sc-suggest-h">
          <h3 id="sc-suggest-h" className="sc-check-h">Things you could add</h3>
          <p className="hint">Questions about things your quotes usually cover. Nothing here is on the quote unless you add it.</p>
          <ul className="sc-suggest-list">
            {suggestions.map((sg, i) => (
              <li key={i} className="sc-suggest-item">
                <span>{sg.question}</span>
                <button type="button" className="btn btn-secondary sc-suggest-add" onClick={() => onAddStep(sg.step ?? '')} aria-label={`Add a step: ${sg.question}`}>
                  Add a step
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
