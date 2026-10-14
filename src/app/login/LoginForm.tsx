'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';

type Step = 'email' | 'code';

async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    return { ok: res.ok && data.ok === true, status: res.status, message: data.message ?? 'Something went wrong. Please try again.' };
  } catch {
    return { ok: false, status: 0, message: 'We could not reach the server. Check your connection and try again.' };
  }
}

export function LoginForm() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const r = await post('/api/auth/request-code', { email });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    // The same wording whether or not the address is registered.
    setNotice(r.message);
    setStep('code');
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const r = await post('/api/auth/verify', { email, code });
    if (!r.ok) {
      setBusy(false);
      return setError(r.message);
    }
    window.location.assign('/');
  }

  if (step === 'email') {
    return (
      <form className="login-form" onSubmit={sendCode} noValidate>
        <Field
          id="email"
          label="Email address"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error || undefined}
        />
        <Button type="submit" disabled={busy || email.trim().length === 0}>{busy ? 'Sending' : 'Email me a code'}</Button>
      </form>
    );
  }

  return (
    <form className="login-form" onSubmit={verify} noValidate>
      <p className="login-notice" role="status">{notice}</p>
      <Field
        id="code"
        label="6 digit code"
        hint={`Sent to ${email}`}
        name="code"
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
      <Button type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking' : 'Sign in'}</Button>
      <button type="button" className="linklike" onClick={() => { setStep('email'); setCode(''); setError(''); }}>
        Use a different email
      </button>
    </form>
  );
}
