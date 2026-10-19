'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../../components/Button';
import { Field } from '../../../../components/Field';
import { ReviewPreview } from '../../../../components/quote/ReviewPreview';
import type { GuaranteeContext, GuaranteeDraft, GuaranteeJobOption } from '../../../../lib/data/guarantees';
import type { DraftPreview } from '../../../../lib/documents/draft-preview';
import { defaultYearsText, emptyGuarantee, GUARANTEE_LIMITS, guaranteeErrors, ROOF_TYPES, type GuaranteeErrors, type GuaranteeValues, type RoofKey } from '../../../../lib/guarantee/model';
import { longDate } from '../../../../lib/documents/map';
import { saveGuaranteeAction } from './guarantee-actions';
import '../../../../styles/guarantee.css';

const SAVE_DELAY_MS = 1200;
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'error'; message: string };
type Touched = Partial<Record<keyof GuaranteeValues, boolean>>;

/** The address a customer's job usually starts from. */
const customerAddress = (c: { addressLine: string; postcode: string }) => [c.addressLine, c.postcode].filter(Boolean).join(', ');

export function GuaranteeForm({ ctx, draft, presetJobId }: { ctx: GuaranteeContext; draft: GuaranteeDraft | null; presetJobId: string | null }) {
  const router = useRouter();
  const preset = presetJobId ? (ctx.jobs.find((j) => j.id === presetJobId) ?? null) : null;
  const [values, setValues] = useState<GuaranteeValues>(() => draft?.values ?? emptyGuarantee(preset ? { address: preset.propertyAddress, linkedQuote: preset.hasQuote ? preset.reference : '' } : {}));
  const [docId, setDocId] = useState<string | null>(draft?.documentId ?? null);
  const [number, setNumber] = useState(draft?.number ?? '');
  const [forLine, setForLine] = useState(draft ? `${draft.customerName}, job ${draft.jobReference}` : '');
  const [mode, setMode] = useState<'job' | 'customer'>(ctx.jobs.length === 0 ? 'customer' : 'job');
  const [jobId, setJobId] = useState(preset?.id ?? '');
  const [customerId, setCustomerId] = useState('');
  const [newRef, setNewRef] = useState('');
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const [problem, setProblem] = useState<{ message: string; field?: string; existingId?: string } | null>(null);
  const [touched, setTouched] = useState<Touched>({});
  const [attempted, setAttempted] = useState(false);
  const lastPreview = useRef<Extract<DraftPreview, { state: 'ready' }> | null>(null);

  const rev = useRef(0);
  const savedRev = useRef(0);
  const valuesRef = useRef(values);
  const docRef = useRef<string | null>(docId);
  const inFlight = useRef<Promise<void> | null>(null);
  valuesRef.current = values;
  docRef.current = docId;

  const job: GuaranteeJobOption | null = mode === 'job' ? (ctx.jobs.find((j) => j.id === jobId) ?? null) : null;
  const taken = useMemo(() => new Map((job?.certificates ?? []).filter((c) => c.documentId !== docId).map((c) => [c.roofKey, c])), [job, docId]);
  const errors: GuaranteeErrors = useMemo(() => guaranteeErrors(values, ctx.today), [values, ctx.today]);
  const empty: Record<string, boolean> = { roofType: values.roofType === '', roofOther: values.roofOther.trim() === '', years: values.years === '', address: values.address.trim() === '', completedOn: values.completedOn === '' };
  // A box with something wrong in it always says so; an empty one says so once it has been visited or Preview was tried.
  const shown = (f: keyof GuaranteeValues): string | undefined => (errors[f] && (!empty[f] || touched[f] || attempted) ? errors[f] : undefined);
  const hasWrongBox = Object.keys(errors).some((f) => !empty[f]);
  const touch = (f: keyof GuaranteeValues) => setTouched((t) => ({ ...t, [f]: true }));

  const patch = useCallback((p: Partial<GuaranteeValues>) => {
    rev.current += 1;
    setValues((v) => ({ ...v, ...p }));
  }, []);

  // ---- the autosave: one at a time, never losing the newest edit
  const runSave = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    // Nothing waiting: do not start a loop. (A loop that ends without awaiting would clear inFlight before it is set,
    // leaving a finished promise behind that every later save would return without saving.)
    if (!docRef.current || savedRev.current === rev.current) return Promise.resolve();
    // A box with something wrong in it is not saved; the screen says which. Checked here, before any promise exists, for the same reason.
    const wrong = () => Object.keys(guaranteeErrors(valuesRef.current, ctx.today)).some((f) => valuesRef.current[f as keyof GuaranteeValues] !== '' && f !== 'roofOther');
    if (wrong()) {
      setSave({ kind: 'error', message: 'Not saved yet. Put right the box marked in red and it will save.' });
      return Promise.resolve();
    }
    const p = (async () => {
      try {
        while (docRef.current && savedRev.current !== rev.current) {
          const mine = rev.current;
          setSave({ kind: 'saving' });
          const res = await saveGuaranteeAction({ documentId: docRef.current, job: null, values: valuesRef.current }).catch(() => null);
          if (!res) {
            setSave({ kind: 'error', message: 'Not saved. Check your connection. We will try again when you change something.' });
            return;
          }
          if (!res.ok) {
            setProblem({ message: res.message, field: res.field, existingId: res.existingId });
            setSave({ kind: 'error', message: res.message });
            return;
          }
          setProblem(null);
          savedRev.current = mine;
          if (savedRev.current !== rev.current && wrong()) {
            setSave({ kind: 'error', message: 'Not saved yet. Put right the box marked in red and it will save.' });
            return;
          }
          setSave({ kind: 'saved', at: clock.format(new Date()) });
        }
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, [ctx.today]);

  const flushSave = useCallback(async (): Promise<boolean> => {
    for (let i = 0; i < 3 && docRef.current && savedRev.current !== rev.current; i++) await runSave();
    return savedRev.current === rev.current;
  }, [runSave]);

  useEffect(() => {
    if (!docId || savedRev.current === rev.current) return;
    const t = setTimeout(() => void runSave(), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [values, docId, runSave]);

  // ---- choosing the job
  const chooseJob = (id: string) => {
    setJobId(id);
    setProblem(null);
    const j = ctx.jobs.find((x) => x.id === id);
    if (j) patch({ address: values.address.trim() === '' || !touched.address ? j.propertyAddress : values.address, linkedQuote: j.hasQuote ? j.reference : '' });
  };
  const chooseCustomer = (id: string) => {
    setCustomerId(id);
    setProblem(null);
    const c = ctx.customers.find((x) => x.id === id);
    if (c && (values.address.trim() === '' || !touched.address)) patch({ address: customerAddress(c) });
  };
  const chooseRoof = (key: RoofKey) => {
    // The years follow the roof type until the owner changes them: only a box still empty or still at the old type's years moves.
    const follows = values.years === '' || values.years === defaultYearsText(values.roofType);
    patch({ roofType: key, ...(follows ? { years: defaultYearsText(key) } : {}) });
    setProblem(null);
  };

  const createDraft = async () => {
    setProblem(null);
    if (mode === 'job' && !jobId) return setProblem({ message: 'Choose the job the certificate is for.', field: 'job' });
    if (mode === 'customer' && !customerId) return setProblem({ message: 'Choose the customer.', field: 'customer' });
    if (mode === 'customer' && newRef.trim() === '') return setProblem({ message: 'Give the new job a number.', field: 'jobReference' });
    if (values.roofType === '') {
      setTouched((t) => ({ ...t, roofType: true }));
      return setProblem({ message: 'Choose the type of roof first.', field: 'roofType' });
    }
    if (hasWrongBox) return setProblem({ message: 'Put right the box marked in red first.' });
    setSave({ kind: 'saving' });
    const mine = rev.current;
    const res = await saveGuaranteeAction({ documentId: null, job: mode === 'job' ? { kind: 'existing', id: jobId } : { kind: 'new', customerId, reference: newRef }, values }).catch(() => null);
    if (!res || !res.ok) {
      setSave({ kind: 'idle' });
      return setProblem(res && !res.ok ? { message: res.message, field: res.field, existingId: res.existingId } : { message: 'We could not save that. Check your connection and try again.' });
    }
    savedRev.current = mine;
    setDocId(res.value.documentId);
    docRef.current = res.value.documentId;
    setNumber(res.value.number);
    const c = mode === 'job' ? job?.customerName : ctx.customers.find((x) => x.id === customerId)?.name;
    setForLine(`${c ?? 'Customer'}, job ${res.value.jobReference}`);
    setSave({ kind: 'saved', at: clock.format(new Date()) });
    window.history.replaceState(null, '', `/documents/new?type=guarantee&draft=${encodeURIComponent(res.value.documentId)}`);
  };

  const toPreview = async () => {
    setAttempted(true);
    const ok = await flushSave();
    const id = docRef.current;
    if (!id || !ok) return;
    if (Object.keys(errors).length > 0) {
      const first = (['roofType', 'roofOther', 'years', 'address', 'completedOn', 'linkedQuote'] as const).find((f) => errors[f]);
      if (first) document.getElementById(`gc-${first}`)?.focus();
      return;
    }
    router.push(`/documents/${encodeURIComponent(id)}/preview`);
  };

  const saveText = save.kind === 'saving' ? 'Saving' : save.kind === 'saved' ? `Saved at ${save.at}. It saves as you go.` : save.kind === 'error' ? save.message : docId ? 'Saved. It saves as you go.' : 'Not saved yet. Choose the job and the roof, then save the draft.';
  const locked = docId !== null;
  const roofErr = shown('roofType');
  const issued = longDate(ctx.today);
  const jobErr = problem?.field === 'job' || problem?.field === 'customer' || problem?.field === 'jobReference' ? problem.message : undefined;

  return (
    <div className="gc-layout">
      <div className="gc-main">
        <p className={`qt-save${save.kind === 'error' ? ' is-error' : save.kind === 'saved' ? ' is-saved' : ''}`} role="status" aria-live="polite">{saveText}</p>

        <section aria-labelledby="gc-for-h" className="qt-step">
          <div className="fgroup">
            <h2 id="gc-for-h" className="fgroup-h">Who it is for</h2>
            {locked ? (
              <div className="qt-locked">
                <div className="qt-locked-main">
                  <strong>{forLine}</strong>
                  <span>Certificate {number}. The job is fixed once the draft is saved.</span>
                </div>
              </div>
            ) : mode === 'job' ? (
              <>
                <div className="field">
                  <label htmlFor="gc-job">Job</label>
                  <select id="gc-job" className="input" value={jobId} onChange={(e) => chooseJob(e.target.value)} aria-invalid={jobErr ? true : undefined} aria-describedby={jobErr ? 'gc-job-err' : undefined}>
                    <option value="">Choose a job</option>
                    {ctx.jobs.map((j) => (
                      <option key={j.id} value={j.id}>{`${j.customerName}, ${j.reference}${j.propertyAddress ? `, ${j.propertyAddress}` : ''}`}</option>
                    ))}
                  </select>
                  {jobErr ? <p className="error" id="gc-job-err">{jobErr}</p> : null}
                </div>
                <button type="button" className="linklike gc-switch" onClick={() => { setMode('customer'); setProblem(null); }}>The job is not on the list</button>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="gc-customer">Customer</label>
                  <select id="gc-customer" className="input" value={customerId} onChange={(e) => chooseCustomer(e.target.value)} aria-invalid={problem?.field === 'customer' ? true : undefined}>
                    <option value="">Choose a customer</option>
                    {ctx.customers.map((c) => (
                      <option key={c.id} value={c.id}>{[c.name, c.postcode].filter(Boolean).join(', ')}</option>
                    ))}
                  </select>
                  {problem?.field === 'customer' ? <p className="error">{problem.message}</p> : null}
                </div>
                <Field announce={false} id="gc-jobReference" label="Job number" hint="A new job is made for this certificate. Pick a number you will recognise, such as the one the quote will use." autoComplete="off" autoCapitalize="characters" spellCheck={false} value={newRef} onChange={(e) => setNewRef(e.target.value)} maxLength={40} error={problem?.field === 'jobReference' ? problem.message : undefined} />
                {ctx.jobs.length > 0 ? <button type="button" className="linklike gc-switch" onClick={() => { setMode('job'); setProblem(null); }}>Choose a job we already have</button> : null}
              </>
            )}
            {job && job.certificates.length > 0 && !locked ? (
              <p className="doc-note" role="note">
                This job already has {job.certificates.length === 1 ? 'a certificate' : `${job.certificates.length} certificates`}:{' '}
                {job.certificates.map((c, i) => (
                  <span key={c.documentId}>{i > 0 ? ', ' : ''}<Link href={`/documents/${c.documentId}`}>{c.number}</Link>{c.roof ? ` (${c.roof.toLowerCase()}, ${c.status === 'draft' ? 'draft' : 'issued'})` : ''}</span>
                ))}
                . A job has one certificate for each type of roof.
              </p>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="gc-roof-h" className="qt-step">
          <div className="fgroup">
            <h2 id="gc-roof-h" className="fgroup-h">The roof</h2>
            <fieldset className="qt-plans gc-roofs" aria-describedby={roofErr ? 'gc-roofType-err' : undefined}>
              <legend className="sr-only">Type of roof</legend>
              {ROOF_TYPES.map((r) => {
                const used = taken.get(r.key);
                return (
                  <label key={r.key} className={`qt-opt gc-opt${values.roofType === r.key ? ' is-on' : ''}${used ? ' is-used' : ''}`}>
                    <input type="radio" name="roof" id={r.key === 'flat' ? 'gc-roofType' : undefined} checked={values.roofType === r.key} disabled={Boolean(used)} onChange={() => chooseRoof(r.key)} onBlur={() => touch('roofType')} />
                    <span className="qt-opt-main">
                      <span className="qt-opt-title">{r.label}</span>
                      {used ? <span className="qt-opt-meta">Already has certificate {used.number}</span> : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {roofErr ? <p className="error" id="gc-roofType-err" role="alert">{roofErr}</p> : null}
            {problem?.field === 'roofType' ? (
              <p className="error" role="alert">
                {problem.message} {problem.existingId ? <Link href={`/documents/${problem.existingId}`}>Open it</Link> : null}
              </p>
            ) : null}
            {values.roofType === 'other' ? (
              <Field announce={false} id="gc-roofOther" label="What is the roof?" hint="This goes on the certificate after the word the, for example garage roof." autoComplete="off" value={values.roofOther} onChange={(e) => patch({ roofOther: e.target.value })} onBlur={() => touch('roofOther')} error={shown('roofOther')} maxLength={GUARANTEE_LIMITS.roofOther} />
            ) : null}
            <Field announce={false} id="gc-address" label="Address of the roof" hint="Filled from the job. Change it if the roof is somewhere else. It goes on the certificate as you type it." autoComplete="off" value={values.address} onChange={(e) => { patch({ address: e.target.value }); touch('address'); }} onBlur={() => touch('address')} error={shown('address')} maxLength={GUARANTEE_LIMITS.address} />
          </div>
        </section>

        <section aria-labelledby="gc-g-h" className="qt-step">
          <div className="fgroup">
            <h2 id="gc-g-h" className="fgroup-h">The guarantee</h2>
            <div className="fgroup-row">
              <Field announce={false} id="gc-years" label="Years" type="text" inputMode="numeric" pattern="[0-9]*" hint={`From ${GUARANTEE_LIMITS.years.min} to ${GUARANTEE_LIMITS.years.max}. Starts at 20 for flat roofs and 25 for tiled roofs; change it if this one is different.`} autoComplete="off" value={values.years} onChange={(e) => patch({ years: e.target.value.replace(/[^0-9]/g, '').slice(0, 2) })} onBlur={() => touch('years')} error={shown('years')} />
              <Field announce={false} id="gc-completedOn" label="Date the installation was completed" type="date" hint="The day the work was really finished. It cannot be in the future." value={values.completedOn} onChange={(e) => patch({ completedOn: e.target.value })} onBlur={() => touch('completedOn')} error={shown('completedOn')} min="1990-01-01" max={ctx.today} />
            </div>
            <Field announce={false} id="gc-linkedQuote" label="Quote number (optional)" hint="The quote this certificate is for. It is kept with the certificate and is not printed on it." autoComplete="off" autoCapitalize="characters" spellCheck={false} value={values.linkedQuote} onChange={(e) => patch({ linkedQuote: e.target.value })} onBlur={() => touch('linkedQuote')} error={shown('linkedQuote') ?? (problem?.field === 'linkedQuote' ? problem.message : undefined)} maxLength={GUARANTEE_LIMITS.linkedQuote} />
            <div className="field">
              <p className="gc-label" id="gc-issue-l">Issue date</p>
              <p className="gc-readonly" aria-labelledby="gc-issue-l">{issued}</p>
              <p className="hint">Always today. It is set again on the day you finalise, so a certificate is never backdated.</p>
            </div>
          </div>
        </section>

        <div className="gc-actions">
          {!locked ? (
            <Button type="button" onClick={() => void createDraft()} disabled={save.kind === 'saving'}>{save.kind === 'saving' ? 'Saving' : 'Save the draft'}</Button>
          ) : (
            <Button type="button" onClick={() => void toPreview()} disabled={save.kind === 'saving'}>Preview and finalise</Button>
          )}
          {problem && !problem.field ? <p className="error" role="alert">{problem.message}</p> : null}
          {locked && attempted && Object.keys(errors).length > 0 ? <p className="error" role="alert">A few things are still needed before it can be finalised. They are marked above.</p> : null}
          {!locked ? <p className="hint">Once saved, the certificate appears here and the draft saves as you type.</p> : <p className="hint">You will read every page before it becomes final.</p>}
        </div>
      </div>

      <div className="gc-doc">
        {locked ? (
          <ReviewPreview
            watch={values}
            memory={lastPreview}
            noun="certificate"
            headingLevel={2}
            unsavedHint="The preview appears once the draft is saved."
            getDocumentId={async () => ((await flushSave()) && docRef.current ? docRef.current : null)}
          />
        ) : (
          <div className="gc-doc-empty" aria-live="polite">
            <h2 className="rv-doc-title">Your certificate</h2>
            <p className="hint">Save the draft and the real certificate is drawn here, page 1 of 1, exactly as your customer will see it.</p>
          </div>
        )}
      </div>
    </div>
  );
}
