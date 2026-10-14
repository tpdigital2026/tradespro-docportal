'use client';

import { Field } from '../Field';
import type { StepProps } from './types';

export type NumberStatus = 'idle' | 'checking' | 'free' | 'taken' | 'invalid' | 'error';

const STATUS_TEXT: Record<NumberStatus, string> = {
  idle: '',
  checking: 'Checking that number',
  free: 'That number is free',
  taken: 'That number has already been used. Choose another.',
  invalid: '',
  error: 'We could not check that number just now. It is checked again when you save.',
};

export function JobStep({
  values,
  set,
  err,
  touch,
  ctx,
  locked,
  numberStatus,
}: StepProps & { numberStatus: NumberStatus }) {
  const type = ctx.jobTypes.find((t) => t.id === values.jobTypeId);
  const numErr = err('quoteNumber') ?? (numberStatus === 'taken' ? STATUS_TEXT.taken : undefined);
  const showSuggest = !locked && ctx.suggestedNumber !== '' && values.quoteNumber.trim() !== ctx.suggestedNumber;
  return (
    <section aria-labelledby="step-h" className="qt-step">
      <h2 id="step-h" className="qt-h" tabIndex={-1}>About the job</h2>

      <div className="qt-number">
        <Field announce={false}
          id="quote-number"
          label="Quote number"
          hint={locked ? 'Fixed once the draft is saved. This number is the job reference.' : 'You choose it. It identifies this job on every document.'}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={values.quoteNumber}
          readOnly={locked}
          onChange={(e) => set({ quoteNumber: e.target.value })}
          onBlur={() => touch('quoteNumber')}
          error={numErr}
          maxLength={40}
        />
        <p className={`qt-status${numberStatus === 'free' ? ' is-ok' : ''}`} aria-live="polite">
          {!numErr && !locked ? STATUS_TEXT[numberStatus] : ''}
        </p>
        {showSuggest ? (
          <button type="button" className="linklike" onClick={() => set({ quoteNumber: ctx.suggestedNumber })}>
            Use {ctx.suggestedNumber}, the next free number
          </button>
        ) : null}
      </div>

      <Field announce={false}
        id="quote-date"
        type="date"
        label="Date of the quote"
        value={values.date}
        onChange={(e) => set({ date: e.target.value })}
        onBlur={() => touch('date')}
        error={err('date')}
        min="2000-01-01"
        max="2100-12-31"
      />

      <div className="field">
        <label htmlFor="job-type">Type of job</label>
        <select
          id="job-type"
          className="input"
          value={values.jobTypeId}
          onChange={(e) => set({ jobTypeId: e.target.value })}
          onBlur={() => touch('jobTypeId')}
          aria-describedby="job-type-hint"
          aria-invalid={err('jobTypeId') ? true : undefined}
        >
          <option value="">Not listed</option>
          {ctx.jobTypes.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <p className="hint" id="job-type-hint" aria-live="polite">
          {type ? (type.guaranteeYears ? `Guarantee for this type of job: ${type.guaranteeYears} years.` : 'There is no guarantee set for this type of job.') : 'No guarantee years are set when the job type is not listed.'}
        </p>
        {err('jobTypeId') ? <p className="error">{err('jobTypeId')}</p> : null}
      </div>

      <Field announce={false}
        id="property"
        label="Address of the work"
        hint="Filled from the customer. Change it if the work is somewhere else."
        autoComplete="off"
        value={values.propertyAddress}
        onChange={(e) => set({ propertyAddress: e.target.value })}
        error={err('propertyAddress')}
        maxLength={200}
      />

      <Field announce={false}
        id="scope"
        multiline
        label="What the work covers"
        hint="Describe it in plain words. This is what the customer reads."
        value={values.scopeNotes}
        onChange={(e) => set({ scopeNotes: e.target.value })}
        onBlur={() => touch('scopeNotes')}
        error={err('scopeNotes')}
        maxLength={4000}
        rows={6}
      />
    </section>
  );
}
