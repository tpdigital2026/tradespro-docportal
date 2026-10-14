'use client';

import { useActionState } from 'react';
import { Button } from '../Button';
import { Field } from '../Field';
import type { FormState } from '../../app/(app)/customers/actions';
import type { CustomerFormValues } from '../../lib/validation/customer';

export const EMPTY_VALUES: CustomerFormValues = { name: '', address1: '', address2: '', town: '', postcode: '', email: '', phone: '' };

/** Add and edit share this. The action is bound to the customer id on the server page for edits. */
export function CustomerForm({
  action,
  initial = EMPTY_VALUES,
  submitLabel,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial?: CustomerFormValues;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  const v = state.values ?? initial;
  const e = state.errors ?? {};
  return (
    <form action={formAction} className="cust-form" noValidate>
      {state.message ? <p className="form-error" role="alert">{state.message}</p> : null}
      <Field id="name" name="name" label="Name" autoComplete="off" defaultValue={v.name} error={e.name} maxLength={120} required />
      <Field id="address1" name="address1" label="Address line 1" autoComplete="off" defaultValue={v.address1} error={e.address1} maxLength={120} required />
      <Field id="address2" name="address2" label="Address line 2" hint="Optional" autoComplete="off" defaultValue={v.address2} error={e.address2} maxLength={120} />
      <Field id="town" name="town" label="Town or city" autoComplete="off" defaultValue={v.town} error={e.town} maxLength={120} />
      <Field
        id="postcode"
        name="postcode"
        label="Postcode"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        defaultValue={v.postcode}
        error={e.postcode}
        maxLength={10}
        required
      />
      <Field
        id="email"
        name="email"
        type="email"
        inputMode="email"
        label="Email"
        hint="Optional. Only used to copy into your own emails."
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        defaultValue={v.email}
        error={e.email}
        maxLength={254}
      />
      <Field id="phone" name="phone" type="tel" inputMode="tel" label="Phone" hint="Optional" autoComplete="off" defaultValue={v.phone} error={e.phone} maxLength={20} />
      <Button type="submit" className="btn-block-sm" disabled={pending}>{pending ? 'Saving' : submitLabel}</Button>
    </form>
  );
}
