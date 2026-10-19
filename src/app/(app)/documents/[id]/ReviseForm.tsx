'use client';

import { useActionState } from 'react';
import { reviseAction, type ReviseState } from './actions';

/** Changing an issued quote: says plainly what will happen before it does. */
export function ReviseForm({ id, number }: { id: string; number: string }) {
  const [state, action, pending] = useActionState<ReviseState, FormData>(reviseAction, null);
  return (
    <form action={action} className="doc-revise">
      <input type="hidden" name="id" value={id} />
      <p className="hint">This makes a new version for you to edit. The one you finalised stays as it is, and you will read and tick the new one before it is final.</p>
      <p className="hint">The new version keeps the number {number}, and so will the invoices and receipts that follow it.</p>
      <button type="submit" className="btn btn-secondary" disabled={pending}>{pending ? 'Opening the quote' : 'Change this quote'}</button>
      {state ? <p className="form-error" role="alert">{state.message}</p> : null}
    </form>
  );
}
