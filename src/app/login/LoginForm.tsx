'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';

type Step = 'email' | 'code';

/** Only used by the demo-mode preview route, so each screen can be seen without signing out. */
export interface PreviewState {
  step: Step;
  error?: string;
  locked?: boolean;
}

/** The server's send limit is per email over 15 minutes; a one minute pause keeps people well inside it. */
export const RESEND_SECONDS = 60;
const LOCKED_TEXT = 'Too many attempts. Please wait a few minutes before trying again.';

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

export function LoginForm({ preview }: { preview?: PreviewState }) {
  const [step, setStep] = useState<Step>(preview?.step ?? 'email');
  const [email, setEmail] = useState(preview ? 'owner@example.com' : '');
  const [code, setCode] = useState('');
  const [error, setError] = useState(preview?.error ?? '');
  const [locked, setLocked] = useState(preview?.locked ?? false);
  const [notice, setNotice] = useState(preview?.step === 'code' ? 'If that email is registered, a code is on its way.' : '');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(preview?.step === 'code' ? 42 : 0);
  const codeRef = useRef<HTMLInputElement>(null);

  // Focus moves to the code field once the code step appears.
  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (wait <= 0 || preview) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait, preview]);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    if (busy || preview) return;
    setBusy(true);
    setError('');
    const r = await post('/api/auth/request-code', { email });
    setBusy(false);
    if (r.status === 429) {
      setLocked(true);
      return setError(LOCKED_TEXT);
    }
    if (!r.ok) return setError(r.message);
    setLocked(false);
    // The same wording whether or not the address is registered.
    setNotice(r.message);
    setWait(RESEND_SECONDS);
    setStep('code');
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (busy || preview) return;
    setBusy(true);
    setError('');
    const r = await post('/api/auth/verify', { email, code });
    if (!r.ok) {
      setBusy(false);
      setCode('');
      codeRef.current?.focus();
      return setError(r.status === 429 ? LOCKED_TEXT : r.message);
    }
    window.location.assign('/');
  }

  const status = (
    <p className={`login-status${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}>
      {error || notice}
    </p>
  );

  if (step === 'email') {
    return (
      <>
        <div className="signin-head">
          <h1>
            <span className="muted">Welcome back.</span>
            Sign in
          </h1>
          <p className="lede">We email you a 6 digit code. No password to remember.</p>
        </div>
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
          />
          <Button type="submit" disabled={busy || locked || email.trim().length === 0}>{busy ? 'Sending' : 'Email me a code'}</Button>
          {status}
        </form>
      </>
    );
  }

  return (
    <>
      <div className="signin-head">
        <h1>
          <span className="muted">Check your email.</span>
          Enter your code
        </h1>
        <p className="lede">We sent a 6 digit code to {email}.</p>
      </div>
      <form className="login-form" onSubmit={verify} noValidate>
        <Field
          ref={codeRef}
          id="code"
          label="6 digit code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          placeholder="000000"
          className="code-input"
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <Button type="submit" disabled={busy || locked || code.length !== 6}>{busy ? 'Checking' : 'Sign in'}</Button>
        {status}
        <div className="login-links">
          <button type="button" className="linklike" onClick={() => { setStep('email'); setCode(''); setError(''); setNotice(''); }}>
            Use a different email
          </button>
          <button type="button" className="linklike" onClick={() => void sendCode()} disabled={busy || locked || wait > 0} aria-describedby="resend-note">
            Send a new code
          </button>
        </div>
        <p id="resend-note" className="login-status">{wait > 0 ? `You can ask for a new code in ${wait} seconds.` : ''}</p>
      </form>
    </>
  );
}
