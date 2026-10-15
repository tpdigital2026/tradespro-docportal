'use client';

import { useRef, useState } from 'react';
import { removeSignatureAction, setSignatureConsentAction, type SettingsResult } from '../../app/(app)/settings/actions';
import { StepUp } from '../StepUp';
import { useGuarded } from './useGuarded';

async function upload(file: File): Promise<SettingsResult> {
  const body = new FormData();
  body.set('file', file);
  try {
    const res = await fetch('/api/settings/signature', { method: 'POST', body, credentials: 'same-origin' });
    const data = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
    if (data.status === 'step-up') return { status: 'step-up' };
    if (data.status === 'ok') return { status: 'ok', message: data.message ?? 'Saved.' };
    return { status: 'error', message: data.message ?? 'That picture could not be saved. Please try again.' };
  } catch {
    return { status: 'error', message: 'We could not reach the server. Check your connection and try again.' };
  }
}

export function SignatureSettings({
  consent,
  hasImage,
  ownerName,
  ownerTitle,
  isOwner,
  email,
  demo,
}: {
  consent: boolean;
  hasImage: boolean;
  ownerName: string;
  ownerTitle: string;
  isOwner: boolean;
  email: string;
  demo: boolean;
}) {
  const [version, setVersion] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // After any change: show the new picture (a new address skips the browser cache) and empty the file picker.
  const g = useGuarded(() => {
    setVersion(Date.now());
    setFile(null);
    if (input.current) input.current.value = '';
  });

  async function choose(f: File | undefined) {
    if (!f) return;
    setFile(f);
    await g.run(() => upload(f));
  }

  const onLabel = consent ? 'On' : 'Off';
  return (
    <div className="set-sig">
      <figure className="set-sig-preview" aria-label="How your signature prints on a document">
        <div className="set-sig-ink">
          {hasImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- a private, session-checked image; not for next/image
            <img src={`/api/settings/signature?v=${version}`} alt={`Signature of ${ownerName}`} width={300} height={100} />
          ) : (
            <span className="set-sig-none">No signature picture yet</span>
          )}
        </div>
        <figcaption className="set-sig-line">
          <span className="set-sig-name">{ownerName}</span>
          <span className="set-sig-role">Authorised signature{ownerTitle ? ` · ${ownerTitle}` : ''}</span>
        </figcaption>
        <p className={consent && hasImage ? 'set-sig-state is-on' : 'set-sig-state'}>
          {consent && hasImage
            ? 'Printed on documents you finalise.'
            : hasImage
              ? 'Not printed. Documents keep a line to sign by hand.'
              : 'Documents keep a line to sign by hand.'}
        </p>
      </figure>

      <div className="set-sig-controls">
        <div className="set-switch-row">
          <div>
            <p className="set-switch-label" id="sig-switch-label">Print my signature on documents</p>
            <p className="hint" id="sig-switch-hint">
              {hasImage ? 'Quotes, invoices and receipts you finalise from now on. Documents already finalised stay as they are.' : 'Add a picture of your signature first.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            className="set-switch"
            aria-checked={consent}
            aria-labelledby="sig-switch-label"
            aria-describedby="sig-switch-hint"
            disabled={!isOwner || g.busy || (!consent && !hasImage)}
            onClick={() => g.run(() => setSignatureConsentAction(!consent))}
          >
            <span className="set-switch-track" aria-hidden="true"><span className="set-switch-knob" /></span>
            <span className="set-switch-text">{onLabel}</span>
          </button>
        </div>

        {isOwner ? (
          <div className="set-upload">
            <label className="btn btn-secondary set-upload-btn" htmlFor="sig-file">
              {hasImage ? 'Change the picture' : 'Add a picture of your signature'}
            </label>
            <input
              ref={input}
              id="sig-file"
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg"
              disabled={g.busy}
              onChange={(e) => void choose(e.target.files?.[0])}
            />
            <p className="hint">Sign on plain white paper in dark ink and take a photo, or use a scan. PNG or JPG, up to 1 MB. We tidy it up and keep only the picture, nothing else from the file.</p>
            {hasImage ? (
              <button type="button" className="linklike set-remove" disabled={g.busy} onClick={() => g.run(() => removeSignatureAction())}>
                Delete the picture
              </button>
            ) : null}
          </div>
        ) : null}

        {g.busy ? <p className="hint" role="status">{file ? 'Tidying up your picture' : 'Saving'}</p> : null}
        {g.stepUp ? (
          <StepUp
            email={email}
            demo={demo}
            idPrefix="su-sig"
            intro={file ? 'before storing your signature' : 'before printing your signature'}
            confirmLabel="Confirm"
            onVerified={g.retry}
            onCancel={() => {
              g.cancel();
              setFile(null);
              if (input.current) input.current.value = '';
            }}
          />
        ) : null}
        {g.error ? <p className="form-error" role="alert">{g.error}</p> : null}
        {g.message ? <p className="set-done" role="status">{g.message}</p> : null}
      </div>
    </div>
  );
}
