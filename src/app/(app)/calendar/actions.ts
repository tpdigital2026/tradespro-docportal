'use server';

import { redirect } from 'next/navigation';
import { checkAppointment, type AppointmentErrors, type AppointmentFormValues } from '../../../lib/calendar/model';
import { AppointmentError, deleteAppointment, isAppointmentId, saveAppointment } from '../../../lib/data/appointments';
import { logFailure } from '../../../lib/log-failure';
import { londonParts } from '../../../lib/london';
import { requireSession } from '../../../lib/session';

export interface AppointmentFormState {
  errors?: AppointmentErrors;
  values?: AppointmentFormValues;
  message?: string;
}

const FIELDS: (keyof AppointmentFormValues)[] = ['kind', 'title', 'date', 'start', 'endDate', 'end', 'customerId', 'jobId', 'notes'];
const GENERIC = 'We could not save that. Please try again.';

function read(fd: FormData): AppointmentFormValues {
  const v = {} as AppointmentFormValues;
  for (const k of FIELDS) {
    const raw = fd.get(k);
    v[k] = typeof raw === 'string' ? raw.slice(0, k === 'notes' ? 2000 : 200) : '';
  }
  return v;
}

/** Add (id null) or change an appointment. The business comes from the session; the browser only sends what was typed. */
export async function saveAppointmentAction(id: string | null, _prev: AppointmentFormState, fd: FormData): Promise<AppointmentFormState> {
  await requireSession();
  if (id !== null && !isAppointmentId(id)) return { message: GENERIC };
  const values = read(fd);
  const checked = checkAppointment(values);
  if (!checked.ok) return { errors: checked.errors, values };
  let saved: string;
  try {
    saved = await saveAppointment(id, checked.value);
  } catch (e) {
    if (e instanceof AppointmentError) return e.field ? { errors: { [e.field]: e.message }, values } : { message: e.message, values };
    logFailure('calendar.save', e);
    return { message: GENERIC, values };
  }
  const day = londonParts(checked.value.startsAt).date;
  redirect(`/calendar?view=agenda&d=${day}&saved=${encodeURIComponent(saved)}`);
}

export interface DeleteState {
  message?: string;
}

export async function deleteAppointmentAction(id: string, _prev: DeleteState): Promise<DeleteState> {
  await requireSession();
  if (!isAppointmentId(id)) return { message: 'That appointment could not be found.' };
  try {
    await deleteAppointment(id);
  } catch (e) {
    if (!(e instanceof AppointmentError)) logFailure('calendar.delete', e);
    return { message: e instanceof AppointmentError ? e.message : 'The appointment could not be deleted. Please try again.' };
  }
  redirect('/calendar?deleted=1');
}
