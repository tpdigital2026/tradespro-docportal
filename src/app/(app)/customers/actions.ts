'use server';

import { redirect } from 'next/navigation';
import { demoErase, demoExtend, createCustomer, updateCustomer } from '../../../lib/data/customers';
import { eraseCustomerWith, extendRetentionWith, withServiceConnection } from '../../../lib/data/customer-admin';
import { isDemo } from '../../../lib/demo';
import { requireSession } from '../../../lib/session';
import { requireFreshStepUpForRequest, StepUpRequiredError } from '../../../lib/step-up-check';
import { getStorage } from '../../../lib/storage';
import { parseCustomerForm, readFormValues, type CustomerFormField, type CustomerFormValues } from '../../../lib/validation/customer';

export interface FormState {
  errors?: Partial<Record<CustomerFormField, string>>;
  values?: CustomerFormValues;
  message?: string;
}

const GENERIC = 'We could not save that. Please try again.';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDemoId = (id: string) => /^demo-customer-[\w-]{1,40}$/.test(id);
const validId = (id: unknown): id is string => typeof id === 'string' && (isDemo() ? isDemoId(id) || ID.test(id) : ID.test(id));

export async function createCustomerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireSession();
  const parsed = parseCustomerForm(formData);
  if (!parsed.ok) return { errors: parsed.errors, values: parsed.values };
  let id: string;
  try {
    id = (await createCustomer(parsed.data)).id;
  } catch {
    return { values: readFormValues(formData), message: GENERIC };
  }
  redirect(`/customers/${id}`);
}

export async function updateCustomerAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  await requireSession();
  if (!validId(id)) return { message: GENERIC };
  const parsed = parseCustomerForm(formData);
  if (!parsed.ok) return { errors: parsed.errors, values: parsed.values };
  try {
    const saved = await updateCustomer(id, parsed.data);
    if (!saved) return { values: readFormValues(formData), message: GENERIC };
  } catch {
    return { values: readFormValues(formData), message: GENERIC };
  }
  redirect(`/customers/${id}?saved=1`);
}

export interface KeepState {
  message?: string;
}

/** "Keep for another N days". Owner or staff of this business; the server resolves the tenant, never the client. */
export async function keepCustomerAction(id: string, _prev: KeepState): Promise<KeepState> {
  const s = await requireSession();
  if (!validId(id)) return { message: GENERIC };
  try {
    if (isDemo()) {
      if (!demoExtend(id)) return { message: GENERIC };
    } else {
      const at = await withServiceConnection((db) => extendRetentionWith(db, { tenantId: s.tenantId, userId: s.userId }, id));
      if (!at) return { message: GENERIC };
    }
  } catch {
    return { message: GENERIC };
  }
  redirect(`/customers/${id}?kept=1`);
}

export type DeleteResult = { status: 'step-up' } | { status: 'error'; message: string };

/**
 * Deletes a customer and everything under it. Owner only, and only with a fresh email code
 * (the browser is sent through the code flow when this answers 'step-up').
 */
export async function deleteCustomerAction(id: string): Promise<DeleteResult> {
  const s = await requireSession();
  if (s.role !== 'owner') return { status: 'error', message: 'Only the owner can delete a customer.' };
  if (!validId(id)) return { status: 'error', message: GENERIC };
  try {
    await requireFreshStepUpForRequest();
  } catch (e) {
    if (e instanceof StepUpRequiredError) return { status: 'step-up' };
    return { status: 'error', message: GENERIC };
  }
  try {
    if (isDemo()) {
      if (!demoErase(id)) return { status: 'error', message: GENERIC };
    } else {
      const r = await withServiceConnection((db) => eraseCustomerWith(db, getStorage(), { tenantId: s.tenantId, userId: s.userId }, id));
      if (r === 'not_found') return { status: 'error', message: GENERIC };
    }
  } catch {
    return { status: 'error', message: 'We could not delete that customer. Nothing was changed. Please try again.' };
  }
  redirect('/customers?deleted=1');
}
