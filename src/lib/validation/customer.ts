import { z } from 'zod';

const CONTROL = /[\u0000-\u001f\u007f]/;
const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/;
const PHONE = /^[0-9+()\s-]{6,20}$/;

const text = (label: string, max: number) =>
  z.string().trim().max(max, `${label} is too long`).refine((v) => !CONTROL.test(v), `${label} has characters we cannot save`);

const optionalText = (label: string, max: number) =>
  text(label, max).transform((v) => (v === '' ? null : v));

export const customerSchema = z.object({
  name: text('The name', 120).min(1, 'Enter the customer name'),
  addressLines: z
    .array(text('The address', 120))
    .transform((lines) => lines.filter((l) => l !== ''))
    .pipe(z.array(z.string()).min(1, 'Enter the first line of the address').max(4)),
  postcode: z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => v.replace(/\s+/g, ' '))
    .pipe(z.string().regex(POSTCODE, 'Enter a UK postcode, like AB1 2CD')),
  email: optionalText('The email', 254).pipe(z.union([z.null(), z.email('Enter a valid email address')])),
  phone: optionalText('The phone number', 20).pipe(z.union([z.null(), z.string().regex(PHONE, 'Enter a phone number using digits only')])),
});

export type CustomerInput = z.output<typeof customerSchema>;

export const FORM_FIELDS = ['name', 'address1', 'address2', 'town', 'postcode', 'email', 'phone'] as const;
export type CustomerFormField = (typeof FORM_FIELDS)[number];
export type CustomerFormValues = Record<CustomerFormField, string>;

export type CustomerParse =
  | { ok: true; data: CustomerInput }
  | { ok: false; errors: Partial<Record<CustomerFormField, string>>; values: CustomerFormValues };

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v : '';
}

/** What was typed, trimmed to a sane length, so the form can be refilled after an error. */
export function readFormValues(fd: FormData): CustomerFormValues {
  return Object.fromEntries(FORM_FIELDS.map((f) => [f, str(fd, f).slice(0, 400)])) as CustomerFormValues;
}

/** Reads the customer form. Values come back so the form can be refilled when there are errors. */
export function parseCustomerForm(fd: FormData): CustomerParse {
  const values = readFormValues(fd);
  const parsed = customerSchema.safeParse({
    name: values.name,
    addressLines: [values.address1, values.address2, values.town],
    postcode: values.postcode,
    email: values.email,
    phone: values.phone,
  });
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors: Partial<Record<CustomerFormField, string>> = {};
  for (const issue of parsed.error.issues) {
    const head = issue.path[0];
    const field: CustomerFormField | null =
      head === 'addressLines'
        ? (['address1', 'address2', 'town'] as const)[typeof issue.path[1] === 'number' ? Math.min(issue.path[1], 2) : 0]
        : head === 'name' || head === 'postcode' || head === 'email' || head === 'phone'
          ? head
          : null;
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return { ok: false, errors, values };
}
