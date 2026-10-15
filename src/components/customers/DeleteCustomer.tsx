'use client';

import { useState } from 'react';
import { Button } from '../Button';
import { StepUp } from '../StepUp';
import { deleteCustomerAction } from '../../app/(app)/customers/actions';

type Phase = 'idle' | 'confirm' | 'step-up';

/**
 * Two steps before anything is deleted: an explicit confirmation, then (when the server asks for it)
 * a fresh emailed code. The server decides; this only follows its answer.
 */
export function DeleteCustomer({ customerId, customerName, ownerEmail, demo = false }: { customerId: string; customerName: string; ownerEmail: string; demo?: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function attempt() {
    setBusy(true);
    setError('');
    // On success the server redirects, so a result only comes back when something needs attention.
    const r = await deleteCustomerAction(customerId).catch(() => ({ status: 'error' as const, message: 'Something went wrong. Please try again.' }));
    setBusy(false);
    if (!r) return;
    if (r.status === 'step-up') return setPhase('step-up');
    setError(r.message);
    setPhase('confirm');
  }

  const keep = () => {
    setPhase('idle');
    setError('');
  };

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
      {phase === 'confirm' ? (
        <div className="cust-actions">
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <Button type="button" variant="secondary" className="btn-block-sm" disabled={busy} onClick={attempt}>
            {busy ? 'Deleting' : 'Delete permanently'}
          </Button>
          <button type="button" className="linklike" onClick={keep}>Keep this customer</button>
        </div>
      ) : (
        <StepUp email={ownerEmail} demo={demo} intro="before deleting" confirmLabel="Confirm and delete" cancelLabel="Keep this customer" onVerified={attempt} onCancel={keep} />
      )}
    </section>
  );
}
