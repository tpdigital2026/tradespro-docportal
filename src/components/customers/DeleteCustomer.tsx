'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '../Button';
import { Field } from '../Field';
import { deleteCustomerAction } from '../../app/(app)/customers/actions';

type Phase = 'idle' | 'confirm' | 'code-email' | 'code-entry' | 'deleting';

async function post(url: string, body: unknown): Promise<{ ok: boolean; message: string }> {
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
 * Two steps before anything is deleted: an explicit confirmation, then (when the server asks for it)
 * a fresh emailed code. The server decides; this only follows its answer.
 */
export function DeleteCustomer({ customerId, customerName, ownerEmail }: { customerId: string; customerName: string; ownerEmail: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function attempt() {
    setBusy(true);
    setError('');
    // On success the server redirects, so a result only comes back when something needs attention.
    const r = await deleteCustomerAction(customerId).catch(() => ({ status: 'error' as const, message: 'Something went wrong. Please try again.' }));
    setBusy(false);
    if (!r) return;
    if (r.status === 'step-up') return setPhase('code-email');
    setError(r.message);
    setPhase('confirm');
  }

  async function sendCode() {
    setBusy(true);
    setError('');
    const r = await post('/api/auth/request-code', { email: ownerEmail });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setPhase('code-entry');
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const r = await post('/api/auth/verify', { email: ownerEmail, code });
    if (!r.ok) {
      setBusy(false);
      return setError(r.message);
    }
    setCode('');
    await attempt();
  }

  if (phase === 'idle') {
    return (
      <div className="cust-danger">
        <button type="button" className="linklike" onClick={() => setPhase('confirm')}>Delete this customer</button>
      </div>
    );
  }

  return (
    <section className="cust-danger" aria-labelledby="delete-h">
      <h2 id="delete-h" className="section-title">Delete {customerName}</h2>
      <p className="cust-warn-text">
        This permanently deletes {customerName} and every document, photo and file kept for them. It cannot be undone.
      </p>
      {phase === 'confirm' || phase === 'deleting' ? (
        <div className="cust-actions">
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <Button type="button" variant="secondary" className="btn-block-sm" disabled={busy} onClick={attempt}>
            {busy ? 'Deleting' : 'Delete permanently'}
          </Button>
          <button type="button" className="linklike" onClick={() => { setPhase('idle'); setError(''); }}>Keep this customer</button>
        </div>
      ) : null}
      {phase === 'code-email' ? (
        <div className="cust-actions">
          <p>For your security we need a fresh code before deleting. We will email one to {ownerEmail}.</p>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <Button type="button" variant="secondary" className="btn-block-sm" disabled={busy} onClick={sendCode}>{busy ? 'Sending' : 'Email me a code'}</Button>
          <button type="button" className="linklike" onClick={() => { setPhase('idle'); setError(''); }}>Keep this customer</button>
        </div>
      ) : null}
      {phase === 'code-entry' ? (
        <form className="cust-actions" onSubmit={verify} noValidate>
          <Field
            id="stepup-code"
            name="code"
            label="6 digit code"
            hint={`Sent to ${ownerEmail}`}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            error={error || undefined}
          />
          <Button type="submit" variant="secondary" className="btn-block-sm" disabled={busy || code.length !== 6}>{busy ? 'Checking' : 'Confirm and delete'}</Button>
          <button type="button" className="linklike" onClick={() => { setPhase('idle'); setCode(''); setError(''); }}>Keep this customer</button>
        </form>
      ) : null}
    </section>
  );
}
