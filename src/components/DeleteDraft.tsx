'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { deleteDraftAction, type DeleteBack } from '../app/(app)/documents/delete-actions';

/**
 * "Delete draft" with a confirmation step. The confirmation is a native modal dialog: focus moves into it, Escape or
 * Cancel closes it and puts focus back on the button that opened it, and nothing is deleted until "Delete draft" inside
 * it is pressed. The server decides whether the draft can go and says why not.
 */
export function DeleteDraft({ documentId, label, back, variant = 'text' }: { documentId: string; label: string; back: DeleteBack; variant?: 'text' | 'row' | 'button' }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onClose = () => {
      setError('');
      opener.current?.focus();
    };
    d.addEventListener('close', onClose);
    return () => d.removeEventListener('close', onClose);
  }, []);

  const open = () => {
    setError('');
    ref.current?.showModal();
  };
  const cancel = () => ref.current?.close();

  async function confirm() {
    setBusy(true);
    setError('');
    // On success the server redirects to the refreshed list, so a result only comes back when something is wrong.
    const r = await deleteDraftAction(documentId, back).catch(() => ({ message: 'We could not delete that draft just now. Please try again.' }));
    setBusy(false);
    if (r) setError(r.message);
  }

  const trigger =
    variant === 'row' ? (
      <button ref={opener} type="button" className="lib-download lib-delete" onClick={open} aria-label={`Delete draft ${label}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" /></svg>
        <span>Delete</span>
      </button>
    ) : (
      <button ref={opener} type="button" className={variant === 'button' ? 'btn btn-secondary del-draft-btn' : 'jt-text del-draft-text'} onClick={open}>
        Delete draft<span className="sr-only"> {label}</span>
      </button>
    );

  return (
    <>
      {trigger}
      <dialog ref={ref} className="del-dialog" aria-labelledby={`${id}-h`} aria-describedby={`${id}-d`}>
        <h2 id={`${id}-h`} className="del-dialog-h">Delete this draft?</h2>
        <p id={`${id}-d`} className="del-dialog-p">
          {label}. This cannot be undone.
        </p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="del-dialog-actions">
          <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Deleting' : 'Delete draft'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={cancel} autoFocus>
            Cancel
          </button>
        </div>
      </dialog>
    </>
  );
}
