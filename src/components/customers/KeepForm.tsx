'use client';

import { useActionState } from 'react';
import { Button } from '../Button';
import { keepCustomerAction, type KeepState } from '../../app/(app)/customers/actions';

export function KeepForm({ customerId, days }: { customerId: string; days: number }) {
  const [state, action, pending] = useActionState(keepCustomerAction.bind(null, customerId), {} as KeepState);
  return (
    <form action={action}>
      <Button type="submit" variant="secondary" className="btn-block-sm" disabled={pending}>
        {pending ? 'Saving' : `Keep for another ${days} days`}
      </Button>
      {state.message ? <p className="form-error" role="alert">{state.message}</p> : null}
    </form>
  );
}
