'use client';

import { useState, type FormEvent } from 'react';
import { setBusinessDetailsAction } from '../../app/(app)/settings/actions';
import type { BusinessDetails } from '../../lib/data/settings';
import { BUSINESS_LIMITS, type BusinessField } from '../../lib/validation/business';
import { Button } from '../Button';
import { Field } from '../Field';
import { StepUp } from '../StepUp';
import { useGuarded } from './useGuarded';

type Form = Record<Exclude<BusinessField, 'addressLines'>, string> & { addressLines: string };

const formOf = (b: BusinessDetails): Form => ({
  email: b.email, phone: b.phone, website: b.website, tagline: b.tagline, addressLines: b.addressLines.join('\n'), postcode: b.postcode,
  companyNumber: b.companyNumber, vatNumber: b.vatNumber, ownerName: b.ownerName, ownerTitle: b.ownerTitle,
});

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={value ? undefined : 'is-missing'}>{value || 'Not on record'}</dd>
    </div>
  );
}

/**
 * Settings > Business details. Everyone in the business sees them; the owner can change them (with a fresh emailed
 * code, as the other Settings changes). Every field is optional: a blank one is left off documents and never blocks one.
 */
export function BusinessDetailsSettings({ business: b, isOwner, email, demo }: { business: BusinessDetails; isOwner: boolean; email: string; demo: boolean }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState<Form>(formOf(b));
  const g = useGuarded(() => setEditing(false));
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    await g.run(() => setBusinessDetailsAction({ ...v, addressLines: v.addressLines.split('\n') }));
  }

  const address = [...b.addressLines, b.postcode].filter(Boolean).join(', ');
  return (
    <div className="set-business">
      {!editing ? (
        <dl className="set-dl">
          <Detail label="Business name" value={b.name} />
          <Detail label="Address" value={address} />
          <Detail label="Phone" value={b.phone} />
          <Detail label="Email" value={b.email} />
          <Detail label="Website" value={b.website} />
          <Detail label="Tagline" value={b.tagline} />
          <Detail label="Company number" value={b.companyNumber} />
          <Detail label="VAT number" value={b.vatRegistered ? b.vatNumber : ''} />
          <Detail label="Your name and title" value={[b.ownerName, b.ownerTitle].filter(Boolean).join(', ')} />
        </dl>
      ) : null}
      <p className="set-note">These print on your documents and covering emails. Documents already finalised keep the details they were made with.</p>
      {isOwner && !editing && !g.stepUp ? (
        <button type="button" className="linklike set-change" onClick={() => { g.clear(); setV(formOf(b)); setEditing(true); }}>
          Change the business details
        </button>
      ) : null}
      {editing && !g.stepUp ? (
        <form className="set-inline-form" onSubmit={save} noValidate>
          <Field id="bd-email" type="email" label="Email" value={v.email} maxLength={BUSINESS_LIMITS.email} autoComplete="email" onChange={set('email')} error={g.errors.email} />
          <Field id="bd-phone" type="tel" label="Phone" value={v.phone} maxLength={BUSINESS_LIMITS.phone} autoComplete="tel" onChange={set('phone')} error={g.errors.phone} />
          <Field id="bd-web" label="Website" hint="As it should print, for example yourbusiness.co.uk." value={v.website} maxLength={BUSINESS_LIMITS.website} autoComplete="url" inputMode="url" onChange={set('website')} error={g.errors.website} />
          <Field id="bd-tag" label="Tagline" value={v.tagline} maxLength={BUSINESS_LIMITS.tagline} autoComplete="off" onChange={set('tagline')} error={g.errors.tagline} />
          <Field id="bd-addr" multiline rows={3} label="Address" hint="One line each, up to four lines. The postcode goes below." value={v.addressLines} onChange={set('addressLines')} error={g.errors.addressLines} />
          <Field id="bd-pc" label="Postcode" value={v.postcode} maxLength={BUSINESS_LIMITS.postcode} autoComplete="postal-code" onChange={set('postcode')} error={g.errors.postcode} />
          <Field id="bd-co" label="Company number" value={v.companyNumber} maxLength={BUSINESS_LIMITS.companyNumber} autoComplete="off" onChange={set('companyNumber')} error={g.errors.companyNumber} />
          <Field id="bd-vat" label="VAT number" hint={b.vatRegistered ? 'Printed on documents that charge VAT.' : 'Your business is not set up as VAT registered, so this is not printed. Contact TradesPro Digital if that has changed.'} value={v.vatNumber} maxLength={BUSINESS_LIMITS.vatNumber} autoComplete="off" onChange={set('vatNumber')} error={g.errors.vatNumber} />
          <Field id="bd-owner" label="Your name" hint="Printed by the signature line." value={v.ownerName} maxLength={BUSINESS_LIMITS.ownerName} autoComplete="name" onChange={set('ownerName')} error={g.errors.ownerName} />
          <Field id="bd-title" label="Your job title" value={v.ownerTitle} maxLength={BUSINESS_LIMITS.ownerTitle} autoComplete="organization-title" onChange={set('ownerTitle')} error={g.errors.ownerTitle} />
          {g.error ? <p className="form-error" role="alert">{g.error}</p> : null}
          <div className="set-row-actions">
            <Button type="submit" pending={g.busy}>{g.busy ? 'Checking' : 'Save'}</Button>
            <button type="button" className="linklike" onClick={() => { setEditing(false); g.clear(); }}>Cancel</button>
          </div>
        </form>
      ) : null}
      {g.stepUp ? <StepUp email={email} demo={demo} idPrefix="su-bd" intro="before changing your business details" confirmLabel="Confirm and save" onVerified={g.retry} onCancel={g.cancel} /> : null}
      {!editing && g.error ? <p className="form-error" role="alert">{g.error}</p> : null}
      {g.message ? <p className="set-done" role="status">{g.message}</p> : null}
    </div>
  );
}
