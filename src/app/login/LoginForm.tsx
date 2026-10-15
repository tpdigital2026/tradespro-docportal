'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { OTP_LENGTH, OTP_PLACEHOLDER } from '../../lib/otp';
import { LOGIN_WINDOW_MINUTES, LOGIN_WINDOW_MS } from '../../lib/login-window';
import { SESSION_EXPIRED_MESSAGE } from '../../lib/signed-out';

type Step = 'email' | 'code';

/** Only used by the demo-mode preview route, so each screen can be seen without signing out. */
export interface PreviewState {
  step: Step;
  error?: string;
  locked?: boolean;
}

/** The server's send limit is per email over 15 minutes; a one minute pause keeps people well inside it. */
export const RESEND_SECONDS = 60;
export const LOCKED_TEXT = `Too many attempts. Please wait ${LOGIN_WINDOW_MINUTES} minutes, then try again.`;
const SENT_TEXT = 'If that email is registered, a code is on its way.';

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

/** signedOut: the session policy ended the last session (idle too long, or past the maximum days). */
export function LoginForm({ preview, signedOut = false }: { preview?: PreviewState; signedOut?: boolean }) {
  const [step, setStep] = useState<Step>(preview?.step ?? 'email');
  const [email, setEmail] = useState(preview ? 'owner@example.com' : '');
  const [code, setCode] = useState('');
  // The address the code went to, fixed at send time so later edits to the field never change the line.
  const [sentTo, setSentTo] = useState(preview ? 'owner@example.com' : '');
  // Typing before hydration is lost when React takes over the field, so the field stays read-only until then.
  const [ready, setReady] = useState(Boolean(preview));
  useEffect(() => setReady(true), []);
  const [error, setError] = useState(preview?.error ?? '');
  const [locked, setLocked] = useState(preview?.locked ?? false);
  const [notice, setNotice] = useState(preview?.step === 'code' ? SENT_TEXT : '');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(preview?.step === 'code' ? 42 : 0);
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const moved = useRef(false);

  // Focus follows the step: the code field after the email step, the email field after "Use a different email".
  useEffect(() => {
    if (!moved.current) return;
    (step === 'code' ? codeRef : emailRef).current?.focus();
  }, [step]);

  useEffect(() => {
    if (wait <= 0 || preview) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait, preview]);

  // A lock lasts as long as the server's window, which is the time the message tells the person.
  useEffect(() => {
    if (!locked || preview) return;
    const t = setTimeout(() => {
      setLocked(false);
      setError('');
    }, LOGIN_WINDOW_MS);
    return () => clearTimeout(t);
  }, [locked, preview]);

  function clearLock() {
    if (!locked) return;
    setLocked(false);
    setError('');
  }

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    if (busy || preview) return;
    setBusy(true);
    setError('');
    const address = email.trim();
    const r = await post('/api/auth/request-code', { email: address });
    setBusy(false);
    if (r.status === 429) {
      setLocked(true);
      setNotice('');
      return setError(LOCKED_TEXT);
    }
    if (!r.ok) {
      setNotice('');
      return setError(r.message);
    }
    // The same wording whether or not the address is registered.
    setSentTo(address);
    setNotice(r.message);
    setWait(RESEND_SECONDS);
    moved.current = true;
    setStep('code');
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (busy || preview) return;
    setBusy(true);
    setError('');
    const r = await post('/api/auth/verify', { email: sentTo, code });
    if (!r.ok) {
      // The server answers a wrong code and a lock the same way, so there is nothing to tell apart here.
      setBusy(false);
      setCode('');
      codeRef.current?.focus();
      setNotice('');
      return setError(r.message);
    }
    window.location.assign('/');
  }

  function differentEmail() {
    clearLock();
    moved.current = true;
    setStep('email');
    setCode('');
    setError('');
    setNotice('');
    setWait(0);
  }

  const isEmail = step === 'email';
  return (
    <>
      <div className="signin-head">
        <h1>
          <span className="muted">{isEmail ? 'Welcome back.' : 'Check your email.'}</span>
          {isEmail ? 'Sign in' : 'Enter your code'}
        </h1>
        <p className="lede">{isEmail ? 'We email you a sign-in code. No password to remember.' : `We sent an ${OTP_LENGTH} digit code to ${sentTo}.`}</p>
      </div>
      {signedOut && isEmail ? <p className="flash signin-flash" role="status">{SESSION_EXPIRED_MESSAGE} Sign in again to carry on.</p> : null}
      <form className="login-form" onSubmit={isEmail ? sendCode : verify} noValidate>
        {isEmail ? (
          <Field
            key="email"
            ref={emailRef}
            id="email"
            label="Email address"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            readOnly={!ready}
            value={email}
            onChange={(e) => {
              clearLock();
              setEmail(e.target.value);
            }}
          />
        ) : (
          <Field
            key="code"
            ref={codeRef}
            id="code"
            label={`${OTP_LENGTH} digit code`}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={OTP_LENGTH}
            placeholder={OTP_PLACEHOLDER}
            className="code-input"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH))}
          />
        )}
        <Button type="submit" disabled={busy || locked || (isEmail ? email.trim().length === 0 : code.length !== OTP_LENGTH)}>
          {isEmail ? (busy ? 'Sending' : 'Email me a code') : busy ? 'Checking' : 'Sign in'}
        </Button>
        {/* Two regions that stay mounted across both steps, so announcements are never lost to a remount. */}
        <div className="login-live">
          <p className="login-status" role="status" aria-live="polite">{notice}</p>
          <p className="login-status is-error" role="alert">{error}</p>
        </div>
        {isEmail ? null : (
          <>
            <div className="login-links">
              <button type="button" className="linklike" onClick={differentEmail}>
                Use a different email
              </button>
              <button type="button" className="linklike" onClick={() => void sendCode()} disabled={busy || locked || wait > 0}>
                Send a new code
              </button>
            </div>
            <p className="login-status" aria-hidden="true">{wait > 0 ? `You can ask for a new code in ${wait} seconds.` : ''}</p>
          </>
        )}
      </form>
    </>
  );
}
