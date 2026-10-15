'use client';

import { useState, type FormEvent } from 'react';
import { setRetentionAction, setSessionPolicyAction } from '../../app/(app)/settings/actions';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, RETENTION_WARNING_DAYS } from '../../lib/retention';
import { IDLE_MINUTES, MAX_SESSION_DAYS } from '../../lib/session-policy-limits';
import { Button } from '../Button';
import { Field } from '../Field';
import { StepUp } from '../StepUp';
import { useGuarded } from './useGuarded';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Minutes as people say them: 30 minutes, 1 hour, 1 hour 30 minutes, 8 hours. */
export function minutesInWords(m: number): string {
  if (m < 60) return plural(m, 'minute', 'minutes');
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${plural(h, 'hour', 'hours')} ${plural(rest, 'minute', 'minutes')}` : plural(h, 'hour', 'hours');
}

export function RetentionSettings({ days, isOwner, email, demo }: { days: number; isOwner: boolean; email: string; demo: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(days));
  const g = useGuarded(() => setEditing(false));

  async function save(e: FormEvent) {
    e.preventDefault();
    await g.run(() => setRetentionAction({ days: value }));
  }

  return (
    <div className="set-ret">
      <div className="set-figure">
        <p className="set-figure-n">{plural(days, 'day', 'days')}</p>
        <p className="set-figure-label">after a customer&rsquo;s last activity, their data is deleted</p>
      </div>
      <ol className="set-steps">
        <li>
          <b>The clock starts again with any activity.</b> Making or changing a quote, invoice, receipt or photo for a customer counts.
        </li>
        <li>
          <b>{RETENTION_WARNING_DAYS} days before the end, you get a warning.</b> It shows on the customer&rsquo;s page with a button to keep their data for another {plural(days, 'day', 'days')}.
        </li>
        <li>
          <b>If nothing happens, it is deleted for good.</b> The customer, their documents, photos and files go. This cannot be undone.
        </li>
      </ol>
      {isOwner && !editing && !g.stepUp ? (
        <button type="button" className="linklike set-change" onClick={() => { g.clear(); setValue(String(days)); setEditing(true); }}>
          Change how long customer data is kept
        </button>
      ) : null}
      {editing && !g.stepUp ? (
        <form className="set-inline-form" onSubmit={save} noValidate>
          <Field
            id="ret-days"
            label="Days to keep customer data"
            hint={`Between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days. A longer time also applies to customers already on file. With a shorter time, customers already on file keep their current deletion date until something happens on their record.`}
            inputMode="numeric"
            autoComplete="off"
            className="set-num"
            value={value}
            maxLength={3}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 3))}
            error={g.errors.days}
           
          />
          {g.error ? <p className="form-error" role="alert">{g.error}</p> : null}
          <div className="set-row-actions">
            <Button type="submit" disabled={g.busy || value === ''}>{g.busy ? 'Checking' : 'Save'}</Button>
            <button type="button" className="linklike" onClick={() => { setEditing(false); g.clear(); }}>Cancel</button>
          </div>
        </form>
      ) : null}
      {g.stepUp ? <StepUp email={email} demo={demo} idPrefix="su-ret" intro="before changing how long customer data is kept" confirmLabel="Confirm and save" onVerified={g.retry} onCancel={g.cancel} /> : null}
      {!editing && g.error ? <p className="form-error" role="alert">{g.error}</p> : null}
      {g.message ? <p className="set-done" role="status">{g.message}</p> : null}
    </div>
  );
}

export function SessionSettings({ idleMinutes, maxDays, isOwner, email, demo }: { idleMinutes: number; maxDays: number; isOwner: boolean; email: string; demo: boolean }) {
  const [editing, setEditing] = useState(false);
  const [idle, setIdle] = useState(String(idleMinutes));
  const [max, setMax] = useState(String(maxDays));
  const g = useGuarded(() => setEditing(false));

  async function save(e: FormEvent) {
    e.preventDefault();
    await g.run(() => setSessionPolicyAction({ idleMinutes: idle, maxDays: max }));
  }

  return (
    <div className="set-sess">
      <dl className="set-pair">
        <div>
          <dt>Signed out after</dt>
          <dd>{minutesInWords(idleMinutes)} <span>with nothing done</span></dd>
        </div>
        <div>
          <dt>Asked to sign in again</dt>
          <dd>every {plural(maxDays, 'day', 'days')} <span>even when busy</span></dd>
        </div>
      </dl>
      <p className="set-note">For everyone in your business, on every phone, tablet and computer. A shorter time is safer if a device could be left open on site or in the van.</p>
      {isOwner && !editing && !g.stepUp ? (
        <button type="button" className="linklike set-change" onClick={() => { g.clear(); setIdle(String(idleMinutes)); setMax(String(maxDays)); setEditing(true); }}>
          Change when people are signed out
        </button>
      ) : null}
      {editing && !g.stepUp ? (
        <form className="set-inline-form" onSubmit={save} noValidate>
          <div className="fgroup-row">
            <Field id="sess-idle" label="Minutes with nothing done" hint={`${IDLE_MINUTES.min} to ${IDLE_MINUTES.max} (8 hours)`} inputMode="numeric" autoComplete="off" className="set-num" value={idle} maxLength={3} onChange={(e) => setIdle(e.target.value.replace(/\D/g, '').slice(0, 3))} error={g.errors.idleMinutes} />
            <Field id="sess-max" label="Days before signing in again" hint={`${MAX_SESSION_DAYS.min} to ${MAX_SESSION_DAYS.max}`} inputMode="numeric" autoComplete="off" className="set-num" value={max} maxLength={2} onChange={(e) => setMax(e.target.value.replace(/\D/g, '').slice(0, 2))} error={g.errors.maxDays} />
          </div>
          {g.error ? <p className="form-error" role="alert">{g.error}</p> : null}
          <div className="set-row-actions">
            <Button type="submit" disabled={g.busy || idle === '' || max === ''}>{g.busy ? 'Checking' : 'Save'}</Button>
            <button type="button" className="linklike" onClick={() => { setEditing(false); g.clear(); }}>Cancel</button>
          </div>
        </form>
      ) : null}
      {g.stepUp ? <StepUp email={email} demo={demo} idPrefix="su-sess" intro="before changing when people are signed out" confirmLabel="Confirm and save" onVerified={g.retry} onCancel={g.cancel} /> : null}
      {!editing && g.error ? <p className="form-error" role="alert">{g.error}</p> : null}
      {g.message ? <p className="set-done" role="status">{g.message}</p> : null}
    </div>
  );
}
