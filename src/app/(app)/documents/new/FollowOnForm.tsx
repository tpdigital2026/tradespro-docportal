'use client';

import { useActionState } from 'react';
import { Button } from '../../../../components/Button';
import { saveFollowOnAction, type FollowOnState } from './followon-actions';

/** The one button on a follow-on page. Everything it saves is recomputed on the server from the job. */
export function FollowOnForm({ job, type, n, payment, exists }: { job: string; type: string; n: number; payment: string | null; exists: boolean }) {
  const [state, action, pending] = useActionState<FollowOnState, FormData>(saveFollowOnAction, null);
  return (
    <form action={action} className="fo-form">
      <input type="hidden" name="job" value={job} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="n" value={n} />
      {payment ? <input type="hidden" name="payment" value={payment} /> : null}
      {state?.message ? <p className="form-error" role="alert">{state.message}</p> : null}
      <Button type="submit" pending={pending}>{pending ? 'Saving' : exists ? 'Open the saved draft' : 'Save as draft'}</Button>
    </form>
  );
}
