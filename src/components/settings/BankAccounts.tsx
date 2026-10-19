'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { addBankAccountAction, archiveBankAccountAction, renameBankAccountAction, setDefaultBankAccountAction } from '../../app/(app)/settings/actions';
import { Button } from '../Button';
import { Field } from '../Field';
import { StepUp } from '../StepUp';
import { useGuarded } from './useGuarded';

export interface BankRow {
  id: string;
  accountName: string;
  bankName: string;
  last4: string;
  isDefault: boolean;
  archived: boolean;
}

const EMPTY = { accountName: '', bankName: '', sortCode: '', accountNumber: '' };

/** Sort code as it is typed: digits only, shown 12-34-56. */
function formatSortCode(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 6);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4, 6)].filter(Boolean).join('-');
}

function Ending({ last4 }: { last4: string }) {
  return (
    <span className="set-ending">
      <span aria-hidden="true">{'•••• '}</span>
      <span className="sr-only">ending </span>
      {last4}
    </span>
  );
}

function AccountRow({ a, isOwner, email, demo }: { a: BankRow; isOwner: boolean; email: string; demo: boolean }) {
  const [mode, setMode] = useState<'view' | 'rename' | 'archive'>('view');
  const [names, setNames] = useState({ accountName: a.accountName, bankName: a.bankName });
  const g = useGuarded(() => setMode('view'));

  async function rename(e: FormEvent) {
    e.preventDefault();
    await g.run(() => renameBankAccountAction(a.id, names));
  }

  return (
    <li className={`set-acct${a.isDefault ? ' is-default' : ''}`}>
      <div className="set-acct-main">
        <p className="set-acct-name">{a.accountName}</p>
        <p className="set-acct-meta">
          {a.bankName ? <span>{a.bankName}</span> : null}
          <Ending last4={a.last4} />
        </p>
      </div>
      {a.isDefault ? <span className="chip is-go set-acct-chip">Default</span> : null}
      {isOwner && mode === 'view' && !g.stepUp ? (
        <div className="set-acct-actions">
          {a.isDefault ? null : (
            <button type="button" className="linklike" disabled={g.busy} onClick={() => g.run(() => setDefaultBankAccountAction(a.id))}>
              Make default
            </button>
          )}
          <button type="button" className="linklike" onClick={() => { g.clear(); setMode('rename'); }}>Rename</button>
          <button type="button" className="linklike" onClick={() => { g.clear(); setMode('archive'); }}>Archive</button>
        </div>
      ) : null}
      {mode === 'rename' && !g.stepUp ? (
        <form className="set-acct-edit" onSubmit={rename} noValidate>
          <div className="fgroup-row">
            <Field id={`rn-name-${a.id}`} label="Account name" value={names.accountName} maxLength={60} autoComplete="off" onChange={(e) => setNames({ ...names, accountName: e.target.value })} error={g.errors.accountName} />
            <Field id={`rn-bank-${a.id}`} label="Bank (optional)" value={names.bankName} maxLength={60} autoComplete="off" onChange={(e) => setNames({ ...names, bankName: e.target.value })} error={g.errors.bankName} />
          </div>
          <p className="hint">The sort code and account number stay as they are. To change those, add the account again and archive this one.</p>
          <div className="set-row-actions">
            <Button type="submit" pending={g.busy}>{g.busy ? 'Saving' : 'Save name'}</Button>
            <button type="button" className="linklike" onClick={() => { setNames({ accountName: a.accountName, bankName: a.bankName }); setMode('view'); g.clear(); }}>Cancel</button>
          </div>
        </form>
      ) : null}
      {mode === 'archive' && !g.stepUp ? (
        <div className="set-acct-edit">
          <p>
            Archive {a.accountName}? It will not be offered for new quotes and invoices. Documents already made with it keep it.
            {a.isDefault ? ' Your oldest other account becomes the default.' : ''}
          </p>
          <div className="set-row-actions">
            <Button type="button" variant="secondary" pending={g.busy} onClick={() => g.run(() => archiveBankAccountAction(a.id))}>{g.busy ? 'Archiving' : 'Archive account'}</Button>
            <button type="button" className="linklike" onClick={() => setMode('view')}>Keep it</button>
          </div>
        </div>
      ) : null}
      {g.stepUp ? (
        <div className="set-acct-edit">
          <StepUp email={email} demo={demo} idPrefix={`su-${a.id}`} intro="before changing your bank accounts" confirmLabel="Confirm" onVerified={g.retry} onCancel={g.cancel} />
        </div>
      ) : null}
      {g.error ? <p className="form-error set-acct-msg" role="alert">{g.error}</p> : null}
      {g.message ? <p className="set-done set-acct-msg" role="status">{g.message}</p> : null}
    </li>
  );
}

export function BankAccounts({ accounts, isOwner, email, demo }: { accounts: BankRow[]; isOwner: boolean; email: string; demo: boolean }) {
  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);
  // The numbers live only in this form until saved, then are wiped from the page.
  const g = useGuarded(() => {
    setForm(EMPTY);
    setAdding(false);
  });

  // After a refused save, move to the first field that needs fixing, so a screen reader hears its message.
  useEffect(() => {
    const first = (['accountName', 'bankName', 'sortCode', 'accountNumber'] as const).find((k) => g.errors[k]);
    if (first) document.getElementById({ accountName: 'acct-name', bankName: 'acct-bank', sortCode: 'acct-sort', accountNumber: 'acct-number' }[first])?.focus();
  }, [g.errors]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (g.busy) return;
    await g.run(() => addBankAccountAction(form));
  }

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [k]: k === 'sortCode' ? formatSortCode(e.target.value) : k === 'accountNumber' ? e.target.value.replace(/\D/g, '').slice(0, 8) : e.target.value });

  return (
    <div className="set-bank">
      {active.length === 0 ? (
        <div className="set-empty">
          <p className="set-empty-title">No bank account yet</p>
          <p>Invoices need one so your customer knows where to pay. Quotes do not.</p>
        </div>
      ) : (
        <ul className="set-accts" aria-label="Bank accounts">
          {active.map((a) => <AccountRow key={a.id} a={a} isOwner={isOwner} email={email} demo={demo} />)}
        </ul>
      )}
      {g.message ? <p className="set-done" role="status">{g.message}</p> : null}

      {isOwner ? (
        adding || g.stepUp ? (
          <div className="set-add" role="group" aria-labelledby="add-acct-h">
            <h3 id="add-acct-h" className="set-add-h">Add an account</h3>
            {g.stepUp ? (
              <>
                <p className="set-held">
                  <b>{form.accountName}</b>
                  {form.bankName ? `, ${form.bankName}` : ''}, account ending {form.accountNumber.slice(-4)}. Nothing is saved until you confirm.
                </p>
                <StepUp email={email} demo={demo} idPrefix="su-add" intro="before saving bank details" confirmLabel="Confirm and save" onVerified={g.retry} onCancel={g.cancel} />
              </>
            ) : (
              <form className="set-add-form" onSubmit={add} noValidate>
                <div className="fgroup-row">
                  <Field id="acct-name" label="Account name" hint="As the bank has it, for example FJC Roofing Ltd" value={form.accountName} maxLength={60} autoComplete="off" onChange={set('accountName')} error={g.errors.accountName} announce={false} />
                  <Field id="acct-bank" label="Bank (optional)" hint="For example Barclays" value={form.bankName} maxLength={60} autoComplete="off" onChange={set('bankName')} error={g.errors.bankName} announce={false} />
                </div>
                <div className="fgroup-row">
                  <Field id="acct-sort" label="Sort code" hint="6 digits" inputMode="numeric" autoComplete="off" value={form.sortCode} maxLength={8} onChange={set('sortCode')} error={g.errors.sortCode} announce={false} />
                  <Field id="acct-number" label="Account number" hint="8 digits. If yours has 7, put a 0 at the front" inputMode="numeric" autoComplete="off" value={form.accountNumber} maxLength={8} onChange={set('accountNumber')} error={g.errors.accountNumber} announce={false} />
                </div>
                <p className="set-safe">
                  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></svg>
                  <span>Once saved we only ever show the last 4 digits, for your safety. The full numbers are stored encrypted and only printed on your invoices.</span>
                </p>
                {g.error ? <p className="form-error" role="alert">{g.error}</p> : null}
                <div className="set-row-actions">
                  <Button type="submit" pending={g.busy}>{g.busy ? 'Checking' : 'Save account'}</Button>
                  <button type="button" className="linklike" onClick={() => { setAdding(false); setForm(EMPTY); g.clear(); }}>Cancel</button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <Button type="button" variant={active.length === 0 ? 'primary' : 'secondary'} className="btn-block-sm" onClick={() => { g.clear(); setAdding(true); }}>
            Add a bank account
          </Button>
        )
      ) : null}

      {archived.length > 0 ? (
        <details className="set-archived">
          <summary>Archived accounts ({archived.length})</summary>
          <ul>
            {archived.map((a) => (
              <li key={a.id}>
                {a.accountName}
                {a.bankName ? `, ${a.bankName}` : ''}, <Ending last4={a.last4} />
              </li>
            ))}
          </ul>
          <p className="hint">Kept because documents you made with them still name them.</p>
        </details>
      ) : null}
    </div>
  );
}
