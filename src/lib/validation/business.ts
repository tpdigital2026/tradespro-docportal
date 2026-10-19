/**
 * Settings > Business details: what the owner may type, checked the same way in the browser and on the server. Pure.
 * Every field is optional: a blank one is simply left off documents, and nothing here ever blocks making a document.
 * The business name is not edited here (it is the business's identity, changed by TradesPro Digital).
 */

export type BusinessField = 'email' | 'phone' | 'website' | 'tagline' | 'addressLines' | 'postcode' | 'companyNumber' | 'vatNumber' | 'ownerName' | 'ownerTitle';
export const BUSINESS_FIELDS: readonly BusinessField[] = ['email', 'phone', 'website', 'tagline', 'addressLines', 'postcode', 'companyNumber', 'vatNumber', 'ownerName', 'ownerTitle'];

export interface BusinessInput {
  email: string;
  phone: string;
  website: string;
  tagline: string;
  /** Up to four lines, each its own line on documents. */
  addressLines: string[];
  postcode: string;
  companyNumber: string;
  vatNumber: string;
  ownerName: string;
  ownerTitle: string;
}

export type BusinessErrors = Partial<Record<BusinessField, string>>;

export const BUSINESS_LIMITS = { email: 120, phone: 30, website: 100, tagline: 120, addressLine: 80, addressLines: 4, postcode: 10, companyNumber: 10, vatNumber: 20, ownerName: 80, ownerTitle: 60 } as const;

const CONTROL = /[\u0000-\u001f\u007f]/;
const tidy = (raw: unknown) => (typeof raw === 'string' ? raw.normalize('NFKC').replace(/\s+/g, ' ').trim() : '');

/**
 * A website as it is printed: no https:// or www-less rewriting, no trailing slash, lower-case host. "https://fjcroofing.co.uk/"
 * becomes "fjcroofing.co.uk". A path is kept (some businesses print one). Null when it is not a web address.
 */
export function displayWebsite(raw: string): string | null {
  const t = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!t) return '';
  const m = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(\/[A-Za-z0-9._~\-/]*)?$/i.exec(t);
  if (!m || !/\.[a-z]{2,}$/i.test(m[1])) return null;
  return `${m[1].toLowerCase()}${m[2] ?? ''}`;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

export function parseBusinessDetails(raw: Partial<Record<BusinessField, unknown>>): { ok: true; value: BusinessInput } | { ok: false; errors: BusinessErrors } {
  const errors: BusinessErrors = {};
  const field = (k: Exclude<BusinessField, 'addressLines'>, max: number, label: string) => {
    const v = tidy(raw[k]);
    if (typeof raw[k] === 'string' && CONTROL.test((raw[k] as string).replace(/\s/g, ' '))) errors[k] = `Remove the unusual characters from the ${label}`;
    else if (v.length > max) errors[k] = `Keep the ${label} to ${max} characters or fewer`;
    return v;
  };
  const email = field('email', BUSINESS_LIMITS.email, 'email address');
  if (email && !errors.email && !EMAIL.test(email)) errors.email = 'Enter an email address like name@example.co.uk';
  const phone = field('phone', BUSINESS_LIMITS.phone, 'phone number');
  if (phone && !errors.phone && !/^\+?[0-9 ()-]{6,}$/.test(phone)) errors.phone = 'Use numbers, spaces and + only in the phone number';
  const websiteRaw = field('website', BUSINESS_LIMITS.website, 'website');
  let website = '';
  if (websiteRaw && !errors.website) {
    const d = displayWebsite(websiteRaw);
    if (d === null) errors.website = 'Enter a website like yourbusiness.co.uk';
    else website = d;
  }
  const tagline = field('tagline', BUSINESS_LIMITS.tagline, 'tagline');
  const postcode = field('postcode', BUSINESS_LIMITS.postcode, 'postcode').toUpperCase();
  const companyNumber = field('companyNumber', BUSINESS_LIMITS.companyNumber, 'company number').toUpperCase();
  if (companyNumber && !errors.companyNumber && !/^[A-Z0-9]{8}$/.test(companyNumber.replace(/\s/g, ''))) errors.companyNumber = 'A company number has 8 characters, like 12345678 or SC123456';
  const vatNumber = field('vatNumber', BUSINESS_LIMITS.vatNumber, 'VAT number').toUpperCase();
  if (vatNumber && !errors.vatNumber && !/^(GB|XI)? ?[0-9]{3} ?[0-9]{4} ?[0-9]{2}( ?[0-9]{3})?$/.test(vatNumber)) errors.vatNumber = 'Enter a VAT number like GB 123456789';
  const ownerName = field('ownerName', BUSINESS_LIMITS.ownerName, 'name');
  const ownerTitle = field('ownerTitle', BUSINESS_LIMITS.ownerTitle, 'job title');

  const rawLines = Array.isArray(raw.addressLines) ? raw.addressLines : typeof raw.addressLines === 'string' ? raw.addressLines.split('\n') : [];
  const addressLines = rawLines.map(tidy).filter(Boolean);
  if (addressLines.length > BUSINESS_LIMITS.addressLines) errors.addressLines = `Use ${BUSINESS_LIMITS.addressLines} address lines or fewer`;
  else if (addressLines.some((l) => l.length > BUSINESS_LIMITS.addressLine)) errors.addressLines = `Keep each address line to ${BUSINESS_LIMITS.addressLine} characters or fewer`;
  else if (rawLines.some((l) => typeof l !== 'string' || CONTROL.test(l.replace(/\s/g, ' ')))) errors.addressLines = 'Remove the unusual characters from the address';

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { email, phone, website, tagline, addressLines, postcode, companyNumber: companyNumber.replace(/\s/g, ''), vatNumber, ownerName, ownerTitle } };
}
