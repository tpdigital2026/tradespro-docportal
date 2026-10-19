'use client';

import { useActionState, useState } from 'react';
import { Button } from '../../../components/Button';
import { deleteAppointmentAction, type DeleteState } from './actions';

/** Asks once before deleting. Nothing else is touched: customers, jobs and documents stay as they are. */
export function DeleteAppointment({ id, title }: { id: string; title: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(deleteAppointmentAction.bind(null, id), {} as DeleteState);
  if (!confirming) {
    return (
      <button type="button" className="linklike cal-delete" onClick={() => setConfirming(true)}>
        Delete this appointment
      </button>
    );
  }
  return (
    <form action={action} className="cal-confirm" aria-labelledby="del-h">
      <p id="del-h" className="cal-confirm-h">Delete &ldquo;{title}&rdquo;?</p>
      <p className="hint">It comes off this calendar. If you added it to your phone, delete it there too.</p>
      {state.message ? <p className="form-error" role="alert">{state.message}</p> : null}
      <div className="cal-confirm-actions">
        <Button type="submit" pending={pending} className="btn-danger">{pending ? 'Deleting' : 'Yes, delete it'}</Button>
        <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>Keep it</Button>
      </div>
    </form>
  );
}
