'use client';

import { useActionState, useState } from 'react';
import { Button } from '../../../components/Button';
import { Field } from '../../../components/Field';
import { APPOINTMENT_KINDS, NOTES_MAX, TITLE_MAX, type AppointmentFormValues } from '../../../lib/calendar/model';
import type { LinkOptions } from '../../../lib/data/appointments';
import type { AppointmentFormState } from './actions';

export function AppointmentForm({
  action,
  initial,
  links,
  submitLabel,
}: {
  action: (prev: AppointmentFormState, fd: FormData) => Promise<AppointmentFormState>;
  initial: AppointmentFormValues;
  links: LinkOptions;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as AppointmentFormState);
  const v = state.values ?? initial;
  const e = state.errors ?? {};
  const [customerId, setCustomerId] = useState(v.customerId);
  const [jobId, setJobId] = useState(v.jobId);
  const [multiDay, setMultiDay] = useState(Boolean(v.endDate));
  const [notes, setNotes] = useState(v.notes);
  const jobs = customerId ? links.jobs.filter((j) => j.customerId === customerId) : links.jobs;

  return (
    <form action={formAction} className="cal-form" noValidate>
      {state.message ? <p className="form-error" role="alert">{state.message}</p> : null}

      <fieldset className="fgroup cal-kinds" aria-describedby={e.kind ? 'kind-error' : undefined}>
        <legend className="fgroup-h">What is it</legend>
        <div className="cal-kind-row">
          {APPOINTMENT_KINDS.map((k) => (
            <label key={k.key} className="cal-kind">
              <input type="radio" name="kind" value={k.key} defaultChecked={v.kind === k.key} />
              <span>{k.label}</span>
            </label>
          ))}
        </div>
        {e.kind ? <p className="error" id="kind-error" role="alert">{e.kind}</p> : null}
      </fieldset>

      <div className="fgroup">
        <Field id="title" name="title" label="Title" hint="A few words you will recognise, like Measure up for fascias." defaultValue={v.title} error={e.title} maxLength={TITLE_MAX} autoComplete="off" required />
      </div>

      <div className="fgroup">
        <h3 className="fgroup-h">When</h3>
        <div className="cal-when">
          <Field id="date" name="date" type="date" label="Date" defaultValue={v.date} error={e.date} required />
          <Field id="start" name="start" type="time" label="Start time" defaultValue={v.start} error={e.start} step={300} required />
          <Field id="end" name="end" type="time" label="End time" hint="Optional" defaultValue={v.end} error={e.end} step={300} />
        </div>
        <label className="cal-check">
          <input type="checkbox" checked={multiDay} onChange={(ev) => setMultiDay(ev.target.checked)} />
          <span>Ends on a later day</span>
        </label>
        {multiDay ? (
          <Field id="endDate" name="endDate" type="date" label="End date" hint="For work that runs over more than one day, up to 14 days." defaultValue={v.endDate} error={e.endDate} />
        ) : (
          <input type="hidden" name="endDate" value="" />
        )}
        <p className="hint">UK time. Times stay right when the clocks change.</p>
      </div>

      <div className="fgroup">
        <h3 className="fgroup-h">Who it is for</h3>
        <div className="fgroup-row">
          <div className="field">
            <label htmlFor="customerId">Customer</label>
            <p className="hint" id="customerId-hint">Optional</p>
            <select
              id="customerId"
              name="customerId"
              className="input"
              value={customerId}
              aria-describedby={['customerId-hint', e.customerId ? 'customerId-error' : ''].filter(Boolean).join(' ')}
              aria-invalid={e.customerId ? true : undefined}
              onChange={(ev) => {
                setCustomerId(ev.target.value);
                if (jobId && !links.jobs.some((j) => j.id === jobId && j.customerId === ev.target.value)) setJobId('');
              }}
            >
              <option value="">No customer</option>
              {links.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {e.customerId ? <p className="error" id="customerId-error" role="alert">{e.customerId}</p> : null}
          </div>
          <div className="field">
            <label htmlFor="jobId">Job</label>
            <p className="hint" id="jobId-hint">{customerId ? 'Optional. Their jobs only.' : 'Optional. Picking a job fills in its customer.'}</p>
            <select
              id="jobId"
              name="jobId"
              className="input"
              value={jobId}
              aria-describedby={['jobId-hint', e.jobId ? 'jobId-error' : ''].filter(Boolean).join(' ')}
              aria-invalid={e.jobId ? true : undefined}
              onChange={(ev) => {
                setJobId(ev.target.value);
                const j = links.jobs.find((x) => x.id === ev.target.value);
                if (j) setCustomerId(j.customerId);
              }}
            >
              <option value="">No job</option>
              {jobs.map((j) => <option key={j.id} value={j.id}>Quote {j.quoteNumber}{customerId ? '' : `, ${j.customerName}`}</option>)}
            </select>
            {e.jobId ? <p className="error" id="jobId-error" role="alert">{e.jobId}</p> : null}
          </div>
        </div>
      </div>

      <div className="fgroup">
        <Field
          id="notes"
          name="notes"
          multiline
          label="Notes"
          hint={`Optional. Plain text, up to ${NOTES_MAX} characters. Notes go into the phone calendar file too.`}
          value={notes}
          onChange={(ev) => setNotes((ev.target as HTMLTextAreaElement).value)}
          error={e.notes}
          maxLength={NOTES_MAX}
        />
        <p className="cal-count" aria-live="polite">{notes.length > NOTES_MAX - 100 ? `${NOTES_MAX - notes.length} characters left` : ''}</p>
      </div>

      <div className="cal-form-actions">
        <Button type="submit" disabled={pending}>{pending ? 'Saving' : submitLabel}</Button>
      </div>
    </form>
  );
}
