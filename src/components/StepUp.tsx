'use client';

import { useState, type FormEvent } from 'react';
import { Button } from './Button';
import { Field } from './Field';
import { OTP_LENGTH } from '../lib/otp';

export async function postJson(url: string, body: unknown): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    return { ok: res.ok && data.ok === true, message: data.message ?? 'Something went wrong. Please try again.' };
  } catch {
    return { ok: false, message: 'We could not reach the server. Check your connection and try again.' };
  }
}

/**
 * The fresh-code check before a sensitive change. The server decides when it is needed (an action answers 'step-up');
 * this only collects the code. Real mode uses the sign-in routes (a real emailed code, verified by Supabase). Demo mode
 * uses the separate demo route, which sends nothing and says which dummy code to type.
 */
export function StepUp({
  email,
  demo,
  intro,
  confirmLabel,
  cancelLabel = 'Cancel',
  onVerified,
  onCancel,
  idPrefix = 'stepup',
}: {
  email: string;
  demo: boolean;
  /** What the code is for, e.g. "before changing your bank details". */
  intro: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Runs once the code has been accepted; it should retry the original action. */
  onVerified(): Promise<void> | void;
  onCancel(): void;
  idPrefix?: string;
}) {
  const [phase, setPhase] = useState<'ask' | 'enter'>('ask');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError('');
    const r = demo ? await postJson('/api/demo/step-up', { action: 'request' }) : await postJson('/api/auth/request-code', { email });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setNotice(demo ? r.message : '');
    setPhase('enter');
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const r = demo ? await postJson('/api/demo/step-up', { action: 'verify', code }) : await postJson('/api/auth/verify', { email, code, stepUp: true });
    if (!r.ok) {
      setBusy(false);
      return setError(r.message);
    }
    setCode('');
    try {
      await onVerified();
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'ask') {
    return (
      <div className="stepup">
        <p className="stepup-text">
          For your security we need a fresh code {intro}. We will email one to <b>{email}</b>.
        </p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="stepup-actions">
          <Button type="button" disabled={busy} onClick={send}>{busy ? 'Sending' : 'Email me a code'}</Button>
          <button type="button" className="linklike" onClick={onCancel}>{cancelLabel}</button>
        </div>
      </div>
    );
  }
  return (
    <form className="stepup" onSubmit={verify} noValidate>
      {notice ? <p className="stepup-demo" role="status">{notice}</p> : null}
      <Field
        id={`${idPrefix}-code`}
        name="code"
        label={`${OTP_LENGTH} digit code`}
        hint={demo ? 'Demo mode: nothing is emailed.' : `Sent to ${email}. It works for 10 minutes.`}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={OTP_LENGTH}
        required
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH))}
        error={error || undefined}
      />
      <div className="stepup-actions">
        <Button type="submit" disabled={busy || code.length !== OTP_LENGTH}>{busy ? 'Checking' : confirmLabel}</Button>
        <button type="button" className="linklike" onClick={onCancel}>{cancelLabel}</button>
      </div>
    </form>
  );
}
