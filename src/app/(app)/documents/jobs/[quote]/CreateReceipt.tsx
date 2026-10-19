'use client';

import { useActionState } from 'react';
import { Button } from '../../../../../components/Button';
import { saveFollowOnAction, type FollowOnState } from '../../new/followon-actions';

/**
 * Right after a payment is saved: one button that makes the receipt draft for that payment (every figure and the number
 * worked out on the server, as on the receipt page) and opens it straight in the preview to read and finalise.
 */
export function CreateReceipt({ quote, instalment, paymentId }: { quote: string; instalment: number; paymentId: string }) {
  const [state, action, pending] = useActionState<FollowOnState, FormData>(saveFollowOnAction, null);
  return (
    <form action={action} className="pay-receipt">
      <input type="hidden" name="job" value={quote} />
      <input type="hidden" name="type" value="receipt" />
      <input type="hidden" name="n" value={instalment} />
      <input type="hidden" name="payment" value={paymentId} />
      <input type="hidden" name="open" value="preview" />
      {state?.message ? <p className="form-error" role="alert">{state.message}</p> : null}
      <Button type="submit" pending={pending}>{pending ? 'Creating the receipt' : 'Create receipt'}</Button>
    </form>
  );
}
