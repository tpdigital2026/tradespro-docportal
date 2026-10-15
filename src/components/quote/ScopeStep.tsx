'use client';

import { useEffect, useRef, useState } from 'react';
import { approveScopeAction, generateScopeCopyAction } from '../../app/(app)/documents/new/scope-actions';
import { applyJobTypeDefaults, isPristine } from '../../lib/scope/defaults';
import { copyErrors, COPY_TOO_OLD, countSteps, isApproved, isStale, scopeErrors, scopeKey, type ScopeCopy, type ScopeFormValues, type ScopeItem } from '../../lib/scope/model';
import { tidyItems } from '../../lib/scope/tidy';
import { Button } from '../Button';
import { ScopeDetails } from '../scope/ScopeDetails';
import { ScopeExamples } from '../scope/ScopeExamples';
import { ScopePreview } from '../scope/ScopePreview';
import { ScopeReview } from '../scope/ScopeReview';
import { ScopeSteps } from '../scope/ScopeSteps';
import type { StepProps } from './types';

interface Props extends StepProps {
  /** Save the draft now and say which job it is. Null when it cannot be saved yet. */
  ensureSaved: () => Promise<string | null>;
  onBack: () => void;
  onContinue: () => void;
}

export function ScopeStep({ values, set, err, touch, ctx, ensureSaved, onBack, onContinue }: Props) {
  const scope = values.scope;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const [view, setView] = useState<'build' | 'review'>(() => (isApproved(scope) ? 'review' : 'build'));
  const [busy, setBusy] = useState<'generating' | 'approving' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tooOld, setTooOld] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const type = ctx.jobTypes.find((t) => t.id === values.jobTypeId);
  const approved = isApproved(scope);
  const stale = isStale(scope);
  const steps = countSteps(scope.items);

  const patchScope = (p: Partial<ScopeFormValues>) => set({ scope: { ...scopeRef.current, ...p } });
  const updateItems = (fn: (items: ScopeItem[]) => ScopeItem[]) => {
    const next = { ...scopeRef.current, items: fn(scopeRef.current.items) };
    scopeRef.current = next;
    set({ scope: next });
    setMessage(null);
  };

  // A scope nobody has touched starts with the title and introduction suggested for this kind of job.
  useEffect(() => {
    if (isPristine(scopeRef.current)) set({ scope: applyJobTypeDefaults(scopeRef.current, ctx.jobTypes, '', values.jobTypeId) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [view]);

  const errors = scopeErrors(scope, 'draft');
  const copyErrs = scope.copy ? copyErrors(scope.copy) : {};

  const generate = async () => {
    if (steps === 0) {
      setMessage('Add at least one step first.');
      return;
    }
    setBusy('generating');
    setMessage(null);
    const sent = scopeRef.current.items;
    const res = await generateScopeCopyAction({ items: sent, jobTypeId: values.jobTypeId }).catch(() => null);
    setBusy(null);
    if (!res) {
      setMessage('We could not tidy that just now. Please try again.');
      return;
    }
    if (!res.ok) {
      setMessage(res.message);
      return;
    }
    if (res.copy.sourceKey !== scopeKey(scopeRef.current.items)) {
      setMessage('You changed the steps while we were working. Press Generate copy again.');
      return;
    }
    setNotice(res.notice);
    setTooOld(false);
    patchScope({ copy: res.copy });
    setView('review');
    window.scrollTo({ top: 0 });
  };

  const editCopy = (fn: (c: ScopeCopy) => ScopeCopy) => {
    const c = scopeRef.current.copy;
    if (!c) return;
    patchScope({ copy: fn(c) });
  };

  const approve = async () => {
    const c = scopeRef.current.copy;
    if (!c) return;
    const bad = Object.values(copyErrors(c))[0];
    if (bad) {
      setMessage(bad);
      return;
    }
    setBusy('approving');
    setMessage(null);
    const jobId = await ensureSaved();
    if (jobId === null) {
      setBusy(null);
      setMessage('The draft is not saved yet. Go back and check the customer and quote number.');
      return;
    }
    const res = await approveScopeAction({ ...valuesRef.current, scope: scopeRef.current }, jobId).catch(() => null);
    setBusy(null);
    if (!res) {
      setMessage('We could not approve that. Please try again.');
      return;
    }
    if (!res.ok) {
      // Old copy is not an error the owner caused: say what to do, with the button right there.
      if (res.message === COPY_TOO_OLD) setTooOld(true);
      else setMessage(res.message);
      return;
    }
    setTooOld(false);
    const now = scopeRef.current.copy;
    if (now) patchScope({ copy: { ...now, approvedAt: res.approvedAt, approvalHash: res.approvalHash } });
  };

  const preview = scope.copy && !stale ? scope.copy.sections : tidyItems(scope.items).sections;
  const previewCaption = scope.copy && !stale ? (approved ? 'Approved wording.' : 'The tidied wording, not yet approved.') : 'Your steps as you typed them, with capital letters and full stops added. Press Generate copy to check the wording.';

  const reviewing = view === 'review' && scope.copy;
  const primary = reviewing
    ? approved
      ? { label: 'Continue to the price', run: onContinue, disabled: false }
      : { label: busy === 'approving' ? 'Approving...' : 'Approve this copy', run: approve, disabled: busy !== null }
    : scope.copy && !stale
      ? { label: 'Review the copy', run: () => setView('review'), disabled: false }
      : { label: busy === 'generating' ? 'Generating...' : 'Generate copy', run: generate, disabled: busy !== null || steps === 0 };

  return (
    <section aria-labelledby="step-h" className="qt-step sc">
      <div className="qt-step-head">
        <h2 id="step-h" className="qt-h" tabIndex={-1} ref={headingRef}>{reviewing ? 'Check the wording' : 'What the work involves'}</h2>
        <p className="qt-lede">
          {reviewing
            ? 'Read it through. Change anything that is not right, then approve it. The price comes next.'
            : 'Write the job one sentence at a time, in the order you do it. Type it, or tap Speak. Then we tidy the wording and you check it.'}
        </p>
      </div>

      {reviewing ? (
        <ScopeReview items={scope.items} copy={scope.copy!} notice={notice} approved={approved} editCopy={editCopy} errors={copyErrs} />
      ) : (
        <div className="sc-build">
          <div className="sc-build-main">
            {stale ? <p className="sc-notice" role="status">You changed the steps after the wording was made. Generate the copy again to check it.</p> : null}
            {scope.items.length === 0 ? (
              <div className="sc-empty">
                <p className="sc-empty-h">No steps yet</p>
                <p>Start with the first thing you do on site. One sentence for each step, like "Strip off and remove the existing roof covering".</p>
              </div>
            ) : null}
            {scope.legacyOverflow ? (
              <section className="sc-legacy" aria-labelledby="sc-legacy-h">
                <h3 id="sc-legacy-h" className="qt-h3">Older notes that did not fit</h3>
                <p className="hint">This draft was started before the step boxes existed, and these notes would not fit as steps. They are not on the quote. Copy anything you need into a step, then discard them.</p>
                <pre className="sc-legacy-text" tabIndex={0}>{scope.legacyOverflow}</pre>
                <div>
                  <Button type="button" variant="secondary" onClick={() => patchScope({ legacyOverflow: '' })}>Discard these notes</Button>
                </div>
              </section>
            ) : null}
            <ScopeSteps items={scope.items} update={updateItems} errors={errors} />
            <ScopeExamples
              types={ctx.jobTypes}
              currentTypeId={values.jobTypeId}
              hasItems={scope.items.length > 0}
              onAdd={(items) => updateItems((cur) => [...cur, ...items])}
            />
            <ScopeDetails scope={scope} patch={patchScope} err={err} touch={touch} type={type} />
          </div>
          <div className="sc-build-side">
            <ScopePreview scope={scope} sections={preview} caption={previewCaption} />
          </div>
        </div>
      )}

      {tooOld && reviewing ? (
        <div className="sc-notice sc-too-old" role="alert">
          <p>{COPY_TOO_OLD}</p>
          <Button type="button" variant="secondary" onClick={generate} disabled={busy !== null}>{busy === 'generating' ? 'Generating...' : 'Generate it again'}</Button>
        </div>
      ) : null}
      {message ? <p className="form-error" role="alert">{message}</p> : null}
      {!approved && !reviewing ? <p className="hint">The price step opens once you have approved the wording.</p> : null}

      <div className="qt-nav sc-nav">
        <Button type="button" variant="secondary" onClick={reviewing ? () => setView('build') : onBack}>
          {reviewing ? 'Back to my steps' : 'Back'}
        </Button>
        <span className="sc-nav-right">
          <Button type="button" onClick={primary.run} disabled={primary.disabled}>{primary.label}</Button>
        </span>
      </div>
      {reviewing ? (
        <p className="hint sc-again">
          Not right?{' '}
          <button type="button" className="linklike" disabled={busy !== null} onClick={generate}>{busy === 'generating' ? 'Generating...' : 'Generate again'}</button>
          . This replaces the wording above, including any changes you made to it.
        </p>
      ) : null}
    </section>
  );
}
