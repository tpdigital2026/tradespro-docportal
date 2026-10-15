'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../../components/Button';
import { Field } from '../../../../components/Field';
import { FindingCard, type FindingUi } from '../../../../components/survey/FindingCard';
import { AutoTextarea, Counter } from '../../../../components/scope/bits';
import { MicIcon, PlusIcon } from '../../../../components/scope/icons';
import { useDictation } from '../../../../components/scope/useDictation';
import type { SurveyContext, SurveyDraft } from '../../../../lib/data/surveys';
import { initials } from '../../../../lib/initials';
import { shrinkPhoto } from '../../../../lib/survey/shrink';
import {
  emptyFinding,
  emptySurvey,
  isFindingApproved,
  isOpinionApproved,
  photoLabel,
  settleApprovals,
  surveyProblems,
  SURVEY_LIMITS,
  tidyLine,
  tidyPara,
  type Finding,
  type SurveyFormValues,
} from '../../../../lib/survey/model';
import { approveSurveyAction, deleteSurveyPhotoAction, draftFindingAction, draftOpinionAction, saveSurveyAction } from './survey-actions';
import { SURVEY_STEPS, type SurveyStep } from '../../../../lib/survey/page';
import '../../../../styles/survey.css';

const STEP_LABEL: Record<SurveyStep, string> = { details: 'Details', findings: 'Findings', conclusion: 'Conclusion', check: 'Check' };
const SAVE_DELAY_MS = 1200;

type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'error'; message: string };
type NewCustomer = { name: string; address1: string; address2: string; town: string; postcode: string; email: string; phone: string };
const EMPTY_CUSTOMER: NewCustomer = { name: '', address1: '', address2: '', town: '', postcode: '', email: '', phone: '' };
const IDLE_UI: FindingUi = { uploading: 0, drafting: false, approving: false, notice: null, error: null };
const SHOWN = 6;

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

function moveIn<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function SurveyForm({ ctx, draft, initialStep, presetJobId }: { ctx: SurveyContext; draft: SurveyDraft | null; initialStep?: SurveyStep; presetJobId?: string | null }) {
  const presetJob = presetJobId ? ctx.jobs.find((j) => j.id === presetJobId) ?? null : null;
  const [values, setValues] = useState<SurveyFormValues>(
    () => draft?.values ?? emptySurvey({ surveyDate: ctx.today, preparedBy: ctx.preparedBy, propertyAddress: presetJob?.propertyAddress ?? '' }),
  );
  const [docId, setDocId] = useState<string | null>(draft?.documentId ?? null);
  const [number, setNumber] = useState<string>(draft?.number ?? '');
  const [customerName, setCustomerName] = useState<string>(draft?.customerName ?? '');
  const [custMode, setCustMode] = useState<'existing' | 'new'>(ctx.customers.length === 0 ? 'new' : 'existing');
  const [customerId, setCustomerId] = useState<string>(draft?.customerId ?? presetJob?.customerId ?? '');
  const [newCust, setNewCust] = useState<NewCustomer>(EMPTY_CUSTOMER);
  const [jobMode, setJobMode] = useState<'new' | 'existing'>(presetJob ? 'existing' : 'new');
  const [jobId, setJobId] = useState<string>(presetJob?.id ?? '');
  const [jobRef, setJobRef] = useState<string>(draft?.jobReference ?? ctx.suggestedNumber);
  const [q, setQ] = useState('');
  const [photos, setPhotos] = useState<Map<string, { width: number; height: number }>>(() => new Map((draft?.photos ?? []).map((p) => [p.id, { width: p.width, height: p.height }])));
  const [ui, setUi] = useState<Record<string, FindingUi>>({});
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const [detailsError, setDetailsError] = useState<{ message: string; field?: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [opinionUi, setOpinionUi] = useState<{ drafting: boolean; approving: boolean; notice: string | null; error: string | null; uncertain: string[] }>({ drafting: false, approving: false, notice: null, error: null, uncertain: [] });
  const startIx = draft && initialStep ? Math.max(0, SURVEY_STEPS.indexOf(initialStep)) : 0;
  const [stepIx, setStepIx] = useState(startIx);
  const [announce, setAnnounce] = useState('');
  const dictation = useDictation();

  const rev = useRef(0);
  const savedRev = useRef(0);
  const valuesRef = useRef(values);
  const docRef = useRef<string | null>(docId);
  const inFlight = useRef<Promise<void> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfter = useRef(false);
  valuesRef.current = values;
  docRef.current = docId;

  const step = SURVEY_STEPS[stepIx];
  const locked = docId !== null;
  const uiOf = (id: string): FindingUi => ui[id] ?? IDLE_UI;
  const setUiOf = (id: string, p: Partial<FindingUi> | ((u: FindingUi) => Partial<FindingUi>)) =>
    setUi((all) => {
      const cur = all[id] ?? IDLE_UI;
      return { ...all, [id]: { ...cur, ...(typeof p === 'function' ? p(cur) : p) } };
    });

  // ---- the autosave: one at a time, never losing the newest edit
  const runSave = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const p = (async () => {
      try {
        while (docRef.current && savedRev.current !== rev.current) {
          const mine = rev.current;
          setSave({ kind: 'saving' });
          const res = await saveSurveyAction({ documentId: docRef.current, customer: null, job: null, values: valuesRef.current }).catch(() => null);
          if (!res) {
            setSave({ kind: 'error', message: 'Not saved. Check your connection. We will try again when you change something.' });
            return;
          }
          if (!res.ok) {
            setSave({ kind: 'error', message: res.message });
            return;
          }
          savedRev.current = mine;
          setSave({ kind: 'saved', at: clock.format(new Date()) });
        }
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, []);

  useEffect(() => {
    if (!docId || savedRev.current === rev.current) return;
    const t = setTimeout(() => void runSave(), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [values, docId, runSave]);

  const patch = useCallback((fn: (v: SurveyFormValues) => SurveyFormValues) => {
    rev.current += 1;
    // Approval holds only while the words and photos are exactly what was approved; the screen drops it at once.
    setValues((v) => settleApprovals(fn(v)));
  }, []);
  const patchFinding = (id: string, p: Partial<Finding>) => patch((v) => ({ ...v, findings: v.findings.map((f) => (f.id === id ? { ...f, ...p } : f)) }));

  // ---- steps
  useEffect(() => {
    if (focusAfter.current) {
      focusAfter.current = false;
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [stepIx]);
  const goTo = (i: number) => {
    if (i > 0 && !locked) return;
    if (docRef.current) void runSave();
    focusAfter.current = true;
    setStepIx(i);
  };

  // ---- step 1: the first save creates the customer (if new), the job and the report
  const chosenCustomer = ctx.customers.find((c) => c.id === customerId) ?? null;
  const customerJobs = ctx.jobs.filter((j) => j.customerId === customerId);
  const term = q.trim().toLowerCase();
  const matches = term ? ctx.customers.filter((c) => `${c.name} ${c.postcode} ${c.addressLine}`.toLowerCase().includes(term)) : ctx.customers.slice(0, SHOWN);
  const list = chosenCustomer && !matches.some((c) => c.id === chosenCustomer.id) ? [chosenCustomer, ...matches] : matches;

  const createReport = async () => {
    setDetailsError(null);
    const customer =
      custMode === 'existing'
        ? customerId
          ? { kind: 'existing' as const, id: customerId }
          : null
        : {
            kind: 'new' as const,
            customer: { name: newCust.name, addressLines: [newCust.address1, newCust.address2, newCust.town], postcode: newCust.postcode, email: newCust.email, phone: newCust.phone },
          };
    if (!customer) return setDetailsError({ message: 'Choose who the survey is for, or add a new customer.', field: 'customer' });
    // A new customer's own address stands in for the property address when none was typed.
    let v = values;
    if (!tidyPara(v.propertyAddress) && custMode === 'new' && newCust.address1.trim()) {
      v = { ...v, propertyAddress: [newCust.address1, newCust.address2, newCust.town, newCust.postcode.toUpperCase()].map((x) => x.trim()).filter(Boolean).join(', ') };
      patch(() => v);
    }
    if (!tidyPara(v.propertyAddress)) return setDetailsError({ message: 'Enter the address of the property you surveyed.', field: 'propertyAddress' });
    const job = custMode === 'existing' && jobMode === 'existing' && jobId ? { kind: 'existing' as const, id: jobId } : { kind: 'new' as const, reference: jobRef };
    setSave({ kind: 'saving' });
    const mine = rev.current;
    const res = await saveSurveyAction({ documentId: null, customer, job, values: v }).catch(() => null);
    if (!res || !res.ok) {
      setSave({ kind: 'idle' });
      return setDetailsError(res && !res.ok ? { message: res.message, field: res.field } : { message: 'We could not save that. Check your connection and try again.' });
    }
    savedRev.current = mine;
    setDocId(res.value.documentId);
    docRef.current = res.value.documentId;
    setNumber(res.value.number);
    setJobRef(res.value.jobReference);
    setCustomerId(res.value.customerId);
    setCustomerName(custMode === 'existing' ? (chosenCustomer?.name ?? '') : newCust.name.trim());
    setSave({ kind: 'saved', at: clock.format(new Date()) });
    window.history.replaceState(null, '', `/documents/new?type=survey&draft=${encodeURIComponent(res.value.documentId)}`);
    if (v.findings.length === 0) patch((x) => ({ ...x, findings: [emptyFinding()] }));
    focusAfter.current = true;
    setStepIx(1);
  };

  // ---- photos
  const addPhotos = async (findingId: string, files: File[]) => {
    const id = docRef.current;
    if (!id) return;
    setUiOf(findingId, (u) => ({ uploading: u.uploading + files.length, error: null }));
    for (const file of files) {
      try {
        const blob = await shrinkPhoto(file);
        const body = new FormData();
        body.append('photo', blob, 'photo.jpg');
        const res = await fetch(`/api/surveys/${encodeURIComponent(id)}/photos`, { method: 'POST', body });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; photo?: { id: string; width: number; height: number } } | null;
        if (!res.ok || !json?.ok || !json.photo) {
          setUiOf(findingId, { error: json?.message ?? 'That photo could not be added. Please try again.' });
        } else {
          const ph = json.photo;
          setPhotos((m) => new Map(m).set(ph.id, { width: ph.width, height: ph.height }));
          patch((v) => ({ ...v, findings: v.findings.map((f) => (f.id === findingId && f.photoIds.length < SURVEY_LIMITS.photosPerFinding ? { ...f, photoIds: [...f.photoIds, ph.id] } : f)) }));
          setAnnounce('Photo added.');
        }
      } catch {
        setUiOf(findingId, { error: 'That photo could not be added. Check your connection and try again.' });
      } finally {
        setUiOf(findingId, (u) => ({ uploading: Math.max(0, u.uploading - 1) }));
      }
    }
  };

  const removePhoto = async (findingId: string, photoId: string) => {
    patch((v) => ({ ...v, coverPhotoId: v.coverPhotoId === photoId ? '' : v.coverPhotoId, findings: v.findings.map((f) => (f.id === findingId ? { ...f, photoIds: f.photoIds.filter((p) => p !== photoId) } : f)) }));
    setAnnounce('Photo removed.');
    await runSave();
    const id = docRef.current;
    if (id) await deleteSurveyPhotoAction(id, photoId).catch(() => null);
  };

  // ---- drafts and approval
  const draftFinding = async (f: Finding) => {
    const id = docRef.current;
    if (!id) return;
    setUiOf(f.id, { drafting: true, notice: null, error: null });
    const res = await draftFindingAction(id, f.ownerLine, f.photoIds).catch(() => null);
    setUiOf(f.id, { drafting: false });
    if (!res || !res.ok) return setUiOf(f.id, { error: res && !res.ok ? res.message : 'We could not draft that just now. Please try again.' });
    const d = res.value;
    // The draft fills the title and the observation. Words the owner has written in the assessment are never replaced.
    const cur = valuesRef.current.findings.find((x) => x.id === f.id);
    patchFinding(f.id, {
      title: d.title || cur?.title || '',
      observation: d.observation,
      assessment: cur && cur.assessment.trim() ? cur.assessment : d.assessment,
      corrections: d.corrections,
      uncertain: d.uncertain,
      engine: d.engine,
    });
    setUiOf(f.id, { notice: d.notice ?? (d.engine === 'ai' ? 'Drafted. Check every word, then approve.' : d.assessment.trim() ? null : 'Your line is in the observation. Now add a title and your professional assessment.') });
  };

  const approve = async (findingId: string | null) => {
    const id = docRef.current;
    if (!id) return;
    if (findingId) setUiOf(findingId, { approving: true, error: null });
    else setOpinionUi((o) => ({ ...o, approving: true, error: null }));
    await runSave();
    const sent = valuesRef.current;
    const res = await approveSurveyAction(id, sent, findingId ? { kind: 'finding', findingId } : { kind: 'opinion' }).catch(() => null);
    if (findingId) setUiOf(findingId, { approving: false, ...(res && res.ok ? { notice: null } : {}) });
    else setOpinionUi((o) => ({ ...o, approving: false }));
    if (!res || !res.ok) {
      const message = res && !res.ok ? res.message : 'We could not record the approval. Please try again.';
      if (findingId) setUiOf(findingId, { error: message });
      else setOpinionUi((o) => ({ ...o, error: message }));
      return;
    }
    const server = res.value.values;
    // Take the approval from the server, and keep it only if nothing has changed on screen since it was sent.
    setValues((v) =>
      settleApprovals(
        findingId
          ? { ...v, findings: v.findings.map((f) => { const s = server.findings.find((x) => x.id === f.id); return f.id === findingId && s ? { ...f, approvedAt: s.approvedAt, approvalHash: s.approvalHash } : f; }) }
          : { ...v, opinionApprovedAt: server.opinionApprovedAt, opinionHash: server.opinionHash },
      ),
    );
    setAnnounce(findingId ? 'Finding approved.' : 'Professional opinion approved.');
    setSave({ kind: 'saved', at: clock.format(new Date()) });
  };

  const draftOpinion = async () => {
    const id = docRef.current;
    if (!id) return;
    setOpinionUi((o) => ({ ...o, drafting: true, notice: null, error: null }));
    await runSave();
    const res = await draftOpinionAction(id, valuesRef.current).catch(() => null);
    setOpinionUi((o) => ({ ...o, drafting: false }));
    if (!res || !res.ok) return setOpinionUi((o) => ({ ...o, error: res && !res.ok ? res.message : 'We could not draft that just now. Please try again.' }));
    const d = res.value;
    patch((v) => ({ ...v, opinion: v.opinion.trim() && v.opinionEngine === null ? v.opinion : d.opinion, opinionEngine: d.engine }));
    setOpinionUi((o) => ({ ...o, notice: d.notice ?? (d.engine === 'ai' ? 'Drafted. Read it as if you were signing it, because you are.' : 'Your line is in the opinion box. Write it out in full as yourself.'), uncertain: d.uncertain }));
  };

  // ---- derived
  const problems = useMemo(() => surveyProblems(values), [values]);
  const approvedCount = values.findings.filter(isFindingApproved).length;
  const usedPhotos = values.findings.flatMap((f, fi) => f.photoIds.map((id, k) => ({ id, label: photoLabel(fi + 1, k + 1) })));
  const saveText =
    save.kind === 'saving' ? 'Saving the draft' : save.kind === 'saved' ? `Draft saved at ${save.at}` : save.kind === 'error' ? save.message : locked ? 'The draft saves as you go.' : 'The draft starts saving once you continue from this step.';

  return (
    <div className="qt-form sv-form">
      <nav aria-label="Survey steps" className="qt-steps">
        <p className="qt-steps-now" aria-hidden="true">
          Step {stepIx + 1} of {SURVEY_STEPS.length}: <strong>{STEP_LABEL[step]}</strong>
        </p>
        <ol>
          {SURVEY_STEPS.map((s, i) => (
            <li key={s}>
              <button type="button" className={`qt-stepbtn${i === stepIx ? ' is-now' : i < stepIx ? ' is-done' : ''}`} aria-current={i === stepIx ? 'step' : undefined} disabled={i > 0 && !locked} onClick={() => goTo(i)}>
                <span className="qt-stepnum" aria-hidden="true">
                  {i < stepIx ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg> : i + 1}
                </span>
                <span className="qt-steplabel">{STEP_LABEL[s]}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <p className={`qt-save${save.kind === 'error' ? ' is-error' : save.kind === 'saved' ? ' is-saved' : ''}`} role="status" aria-live="polite">{saveText}</p>
      <p className="sr-only" aria-live="polite">{announce}</p>

      {step === 'details' ? (
        <section className="qt-body sv-step" aria-labelledby="sv-step-h">
          <div className="qt-step-head">
            <h2 id="sv-step-h" ref={heading} tabIndex={-1} className="qt-h">Who and where</h2>
            <p className="qt-lede">The customer, the property and the job. A new customer is added to your customers when you continue.</p>
          </div>

          <fieldset className="sv-fieldset">
            <legend className="sv-legend">Customer</legend>
            {locked ? (
              <p className="qt-locked">
                <span className="avatar" aria-hidden="true">{initials(customerName || 'Customer')}</span>
                <span className="qt-locked-main"><strong>{customerName || 'Customer'}</strong><span>Fixed once the report is saved.</span></span>
              </p>
            ) : (
              <>
                {ctx.customers.length > 0 ? (
                  <div className="sv-seg" role="radiogroup" aria-label="Customer">
                    <label className={`sv-seg-opt${custMode === 'existing' ? ' is-on' : ''}`}><input type="radio" name="custmode" checked={custMode === 'existing'} onChange={() => setCustMode('existing')} /> Existing customer</label>
                    <label className={`sv-seg-opt${custMode === 'new' ? ' is-on' : ''}`}><input type="radio" name="custmode" checked={custMode === 'new'} onChange={() => setCustMode('new')} /> New customer</label>
                  </div>
                ) : null}
                {custMode === 'existing' ? (
                  <>
                    <Field announce={false} id="sv-cust-q" type="search" label="Find a customer" hint="Type a name or postcode." autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} maxLength={60} />
                    <div role="radiogroup" aria-label="Choose the customer" className="qt-pick">
                      {list.map((c) => (
                        <label key={c.id} className={`qt-opt${c.id === customerId ? ' is-on' : ''}`}>
                          <input
                            type="radio"
                            name="sv-customer"
                            checked={c.id === customerId}
                            onChange={() => {
                              setCustomerId(c.id);
                              setJobMode('new');
                              setJobId('');
                              const addr = [c.addressLine, c.postcode].filter(Boolean).join(', ');
                              if (!values.propertyAddress.trim()) patch((v) => ({ ...v, propertyAddress: addr }));
                            }}
                          />
                          <span className="avatar" aria-hidden="true">{initials(c.name)}</span>
                          <span className="qt-opt-main"><span className="qt-opt-title">{c.name}</span><span className="qt-opt-meta">{[c.addressLine, c.postcode].filter(Boolean).join(', ')}</span></span>
                        </label>
                      ))}
                      {list.length === 0 ? <p className="empty">No customer matches that. Check the spelling, or add them as a new customer.</p> : null}
                    </div>
                  </>
                ) : (
                  <div className="sv-newcust">
                    <Field id="sv-nc-name" label="Name" autoComplete="off" value={newCust.name} maxLength={120} onChange={(e) => setNewCust({ ...newCust, name: e.target.value })} />
                    <Field
                      id="sv-nc-a1"
                      label="Address, first line"
                      autoComplete="off"
                      value={newCust.address1}
                      maxLength={120}
                      onChange={(e) => {
                        const a1 = e.target.value;
                        setNewCust({ ...newCust, address1: a1 });
                      }}
                    />
                    <Field id="sv-nc-a2" label="Address, second line (optional)" autoComplete="off" value={newCust.address2} maxLength={120} onChange={(e) => setNewCust({ ...newCust, address2: e.target.value })} />
                    <div className="sv-two">
                      <Field id="sv-nc-town" label="Town (optional)" autoComplete="off" value={newCust.town} maxLength={120} onChange={(e) => setNewCust({ ...newCust, town: e.target.value })} />
                      <Field id="sv-nc-pc" label="Postcode" autoComplete="off" value={newCust.postcode} maxLength={10} onChange={(e) => setNewCust({ ...newCust, postcode: e.target.value })} />
                    </div>
                    <div className="sv-two">
                      <Field id="sv-nc-email" type="email" label="Email (optional)" autoComplete="off" value={newCust.email} maxLength={254} onChange={(e) => setNewCust({ ...newCust, email: e.target.value })} />
                      <Field id="sv-nc-phone" type="tel" label="Phone (optional)" autoComplete="off" value={newCust.phone} maxLength={20} onChange={(e) => setNewCust({ ...newCust, phone: e.target.value })} />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      className="sv-copy-addr"
                      onClick={() => patch((v) => ({ ...v, propertyAddress: [newCust.address1, newCust.address2, newCust.town, newCust.postcode.toUpperCase()].map((x) => x.trim()).filter(Boolean).join(', ') }))}
                      disabled={!newCust.address1.trim()}
                    >
                      Use this as the property address
                    </Button>
                  </div>
                )}
              </>
            )}
          </fieldset>

          <fieldset className="sv-fieldset">
            <legend className="sv-legend">Job</legend>
            {locked ? (
              <p className="hint">Job {jobRef}. This report is {number}. A quote for this job will use the same job number.</p>
            ) : (
              <>
                {custMode === 'existing' && customerJobs.length > 0 ? (
                  <div role="radiogroup" aria-label="Which job" className="qt-pick">
                    <label className={`qt-opt${jobMode === 'new' ? ' is-on' : ''}`}>
                      <input type="radio" name="sv-job" checked={jobMode === 'new'} onChange={() => setJobMode('new')} />
                      <span className="qt-opt-main"><span className="qt-opt-title">A new job</span><span className="qt-opt-meta">The survey comes first, the quote follows.</span></span>
                    </label>
                    {customerJobs.map((j) => (
                      <label key={j.id} className={`qt-opt${jobMode === 'existing' && jobId === j.id ? ' is-on' : ''}`}>
                        <input type="radio" name="sv-job" checked={jobMode === 'existing' && jobId === j.id} onChange={() => { setJobMode('existing'); setJobId(j.id); if (!values.propertyAddress.trim() && j.propertyAddress) patch((v) => ({ ...v, propertyAddress: j.propertyAddress })); }} />
                        <span className="qt-opt-main"><span className="qt-opt-title">Job {j.reference}</span><span className="qt-opt-meta">{j.propertyAddress || 'No address yet'}</span></span>
                      </label>
                    ))}
                  </div>
                ) : null}
                {jobMode === 'new' || custMode === 'new' ? (
                  <Field
                    className="sv-short"
                    id="sv-jobref"
                    label="Job number"
                    hint={`The quote for this job will use the same number. The report will be SR-${jobRef.trim() || '...'}.`}
                    value={jobRef}
                    maxLength={40}
                    autoComplete="off"
                    error={detailsError?.field === 'jobReference' ? detailsError.message : undefined}
                    announce={false}
                    onChange={(e) => setJobRef(e.target.value)}
                  />
                ) : null}
              </>
            )}
          </fieldset>

          <div className="sv-grid">
            <Field
              id="sv-address"
              multiline
              label="Property address"
              hint="The address of the property you surveyed."
              rows={3}
              value={values.propertyAddress}
              maxLength={SURVEY_LIMITS.address}
              error={detailsError?.field === 'propertyAddress' ? detailsError.message : undefined}
              announce={false}
              onChange={(e) => patch((v) => ({ ...v, propertyAddress: e.target.value }))}
            />
            <div className="sv-stack">
              <Field id="sv-date" type="date" label="Survey date" value={values.surveyDate} max="2100-12-31" onChange={(e) => patch((v) => ({ ...v, surveyDate: e.target.value, signDate: v.signDate === v.surveyDate ? e.target.value : v.signDate }))} />
              <Field id="sv-by" label="Prepared by" hint="Your name, as it goes on the report." value={values.preparedBy} maxLength={SURVEY_LIMITS.preparedBy} onChange={(e) => patch((v) => ({ ...v, preparedBy: e.target.value, signName: v.signName === v.preparedBy ? e.target.value : v.signName }))} />
            </div>
          </div>

          {detailsError && detailsError.field !== 'jobReference' && detailsError.field !== 'propertyAddress' ? <p className="form-error" role="alert">{detailsError.message}</p> : null}
          <div className="qt-nav">
            {locked ? <Button type="button" onClick={() => goTo(1)}>Continue to findings</Button> : <Button type="button" onClick={createReport} disabled={save.kind === 'saving'}>{save.kind === 'saving' ? 'Saving' : 'Save and add findings'}</Button>}
          </div>
        </section>
      ) : null}

      {step === 'findings' ? (
        <section className="sv-step" aria-labelledby="sv-step-h">
          <div className="qt-step-head sv-head-row">
            <div>
              <h2 id="sv-step-h" ref={heading} tabIndex={-1} className="qt-h">Findings</h2>
              <p className="qt-lede">One finding for each thing you found: photos and one line. Draft it, check it, approve it.</p>
            </div>
            <p className="sv-tally" aria-label={`${approvedCount} of ${values.findings.length} findings approved`}>
              <span className="sv-tally-n">{approvedCount}/{values.findings.length}</span> approved
            </p>
          </div>
          <div className="sv-cards">
            {values.findings.map((f, i) => (
              <FindingCard
                key={f.id}
                finding={f}
                index={i}
                count={values.findings.length}
                ui={uiOf(f.id)}
                photos={photos}
                aiOn={ctx.aiOn}
                dictation={dictation}
                canUpload={locked}
                onChange={(p) => patchFinding(f.id, p)}
                onAddPhotos={(files) => void addPhotos(f.id, files)}
                onRemovePhoto={(pid) => void removePhoto(f.id, pid)}
                onMovePhoto={(pid, dir) => patchFinding(f.id, { photoIds: moveIn(f.photoIds, f.photoIds.indexOf(pid), dir) })}
                onDraft={() => void draftFinding(f)}
                onApprove={() => void approve(f.id)}
                onMove={(dir) => {
                  patch((v) => ({ ...v, findings: moveIn(v.findings, i, dir) }));
                  setAnnounce(`Moved to finding ${i + 1 + dir} of ${values.findings.length}. Photo numbers follow.`);
                }}
                onDelete={() => {
                  if (f.photoIds.length + tidyPara(f.observation).length + tidyLine(f.ownerLine).length > 0 && !window.confirm(`Delete finding ${i + 1}? Its photos are removed too.`)) return;
                  patch((v) => ({ ...v, coverPhotoId: f.photoIds.includes(v.coverPhotoId) ? '' : v.coverPhotoId, findings: v.findings.filter((x) => x.id !== f.id) }));
                  setAnnounce(`Finding ${i + 1} deleted.`);
                  void (async () => {
                    await runSave();
                    const id = docRef.current;
                    if (id) for (const pid of f.photoIds) await deleteSurveyPhotoAction(id, pid).catch(() => null);
                  })();
                }}
              />
            ))}
          </div>
          {dictation.problem ? <p className="hint" role="status">{dictation.problem}</p> : null}
          {values.findings.length < SURVEY_LIMITS.findings ? (
            <Button type="button" variant="secondary" className="sv-add" onClick={() => patch((v) => ({ ...v, findings: [...v.findings, emptyFinding()] }))}>
              <PlusIcon /> Add a finding
            </Button>
          ) : (
            <p className="hint">{SURVEY_LIMITS.findings} findings is the most one report can hold.</p>
          )}

          <div className="sv-cover-pick">
          <fieldset className="sv-fieldset">
            <legend className="sv-legend">Cover photo</legend>
            <p className="hint">Choose one of this report&rsquo;s photos for the front page, or keep a plain cover.</p>
            <div className="sv-cover-grid" role="radiogroup" aria-label="Cover photo">
              <label className={`sv-cover-opt${values.coverPhotoId === '' ? ' is-on' : ''}`}>
                <input type="radio" name="sv-cover" checked={values.coverPhotoId === ''} onChange={() => patch((v) => ({ ...v, coverPhotoId: '' }))} />
                <span className="sv-cover-plain" aria-hidden="true" />
                <span className="sv-cover-label">Plain cover</span>
              </label>
              {usedPhotos.map((p) => (
                <label key={p.id} className={`sv-cover-opt${values.coverPhotoId === p.id ? ' is-on' : ''}`}>
                  <input type="radio" name="sv-cover" checked={values.coverPhotoId === p.id} onChange={() => patch((v) => ({ ...v, coverPhotoId: p.id }))} />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/surveys/photos/${p.id}`} alt="" width={160} height={120} loading="lazy" decoding="async" />
                  <span className="sv-cover-label">{p.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          </div>

          <div className="qt-nav">
            <Button type="button" variant="secondary" onClick={() => goTo(0)}>Back to details</Button>
            <Button type="button" onClick={() => goTo(2)}>Continue to conclusion</Button>
          </div>
        </section>
      ) : null}

      {step === 'conclusion' ? (
        <section className="qt-body sv-step" aria-labelledby="sv-step-h">
          <div className="qt-step-head">
            <h2 id="sv-step-h" ref={heading} tabIndex={-1} className="qt-h">Conclusion</h2>
            <p className="qt-lede">Your professional opinion, in your own voice, and your signature.</p>
          </div>
          <div className="field">
            <label htmlFor="sv-concl">What do you conclude?</label>
            <p className="hint" id="sv-concl-hint">One line, in your own words. {dictation.supported ? 'Tap the microphone to speak it.' : 'You can use the microphone on your keyboard.'}</p>
            <div className="sv-line">
              <input id="sv-concl" className="input" value={values.conclusionLine} maxLength={SURVEY_LIMITS.conclusionLine} aria-describedby="sv-concl-hint" autoComplete="off" placeholder="For example: the work was not done to a proper standard and needs putting right" onChange={(e) => patch((v) => ({ ...v, conclusionLine: e.target.value }))} />
              {dictation.supported ? (
                <button type="button" className={`sc-icon-btn sv-mic${dictation.active === 'concl' ? ' is-on' : ''}`} aria-pressed={dictation.active === 'concl'} aria-label={dictation.active === 'concl' ? 'Stop listening' : 'Speak your conclusion'} onClick={() => (dictation.active === 'concl' ? dictation.stop() : dictation.start('concl', values.conclusionLine, (t) => patch((v) => ({ ...v, conclusionLine: t })), SURVEY_LIMITS.conclusionLine))}>
                  <MicIcon />
                </button>
              ) : null}
            </div>
          </div>
          <div className="sv-draft-row">
            <Button type="button" variant="secondary" onClick={draftOpinion} disabled={opinionUi.drafting || !values.conclusionLine.trim()}>
              {opinionUi.drafting ? 'Drafting' : ctx.aiOn ? 'Draft my opinion' : 'Use my line'}
            </Button>
            <p className="hint">{ctx.aiOn ? 'The AI drafts from your line and your approved findings only. It adds nothing new.' : 'Your line goes into the opinion box as you wrote it. Write it out in full as yourself.'}</p>
          </div>
          {opinionUi.notice ? <p className="sv-notice" role="status">{opinionUi.notice}</p> : null}
          <div className="field">
            <label htmlFor="sv-opinion">Professional opinion</label>
            <p className="hint" id="sv-opinion-hint">Written as yourself, for example &ldquo;It is my professional opinion that ...&rdquo;. Leave a blank line between paragraphs.</p>
            <AutoTextarea id="sv-opinion" className={`input sv-text sv-opinion-box${values.opinion.trim() ? '' : ' is-empty'}`} value={values.opinion} maxLength={SURVEY_LIMITS.opinion} placeholder="Add your professional opinion" aria-describedby="sv-opinion-hint sv-opinion-count" onChange={(e) => patch((v) => ({ ...v, opinion: e.target.value }))} />
            <Counter id="sv-opinion-count" length={values.opinion.length} max={SURVEY_LIMITS.opinion} />
          </div>
          {opinionUi.uncertain.length ? (
            <div className="sv-check"><h3 className="sv-check-h">Please check</h3><ul>{opinionUi.uncertain.map((u) => <li key={u}>{u}</li>)}</ul></div>
          ) : null}
          <Field id="sv-remedial" label="Remedial works (optional)" hint="One line for the last page, for example who is to put it right. Leave it empty to leave it out." value={values.remedial} maxLength={SURVEY_LIMITS.remedial} onChange={(e) => patch((v) => ({ ...v, remedial: e.target.value }))} />

          <fieldset className="sv-fieldset">
            <legend className="sv-legend">Signature</legend>
            <p className="hint">The report is signed with your typed name and this date. No signature image is added.</p>
            <div className="sv-two">
              <Field id="sv-sign" label="Typed name" value={values.signName} maxLength={SURVEY_LIMITS.preparedBy} autoComplete="name" onChange={(e) => patch((v) => ({ ...v, signName: e.target.value }))} />
              <Field id="sv-signdate" type="date" label="Date" value={values.signDate} max="2100-12-31" onChange={(e) => patch((v) => ({ ...v, signDate: e.target.value }))} />
            </div>
          </fieldset>

          <div className="sv-approve">
            {isOpinionApproved(values) && values.opinionApprovedAt ? (
              <p className="sv-approved" role="status">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                You approved your opinion at {timeFmt.format(new Date(values.opinionApprovedAt))}. Any change means approving it again.
              </p>
            ) : (
              <>
                <Button type="button" onClick={() => void approve(null)} disabled={opinionUi.approving || !values.opinion.trim() || !values.signName.trim()}>{opinionUi.approving ? 'Approving' : 'I approve this opinion'}</Button>
                <p className="hint">You sign this opinion as {tidyLine(values.signName) || 'yourself'}. It goes on the report exactly as it reads here.</p>
              </>
            )}
            {opinionUi.error ? <p className="error" role="alert">{opinionUi.error}</p> : null}
          </div>
          <div className="qt-nav">
            <Button type="button" variant="secondary" onClick={() => goTo(1)}>Back to findings</Button>
            <Button type="button" onClick={() => goTo(3)}>Continue to check</Button>
          </div>
        </section>
      ) : null}

      {step === 'check' ? (
        <section className="qt-body sv-step" aria-labelledby="sv-step-h">
          <div className="qt-step-head">
            <h2 id="sv-step-h" ref={heading} tabIndex={-1} className="qt-h">{problems.length ? 'Nearly there' : 'Ready to read'}</h2>
            <p className="qt-lede">{problems.length ? 'These need doing before the report can be finalised. Nothing is made up to fill a gap.' : 'Every finding and your opinion are approved. Next you read every page as your customer will, tick to confirm, and it becomes final.'}</p>
          </div>
          {problems.length ? (
            <ul className="missing-list sv-todo">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          ) : null}
          <dl className="doc-facts sv-facts">
            <div><dt>Report</dt><dd>{number || 'Not saved yet'}</dd></div>
            <div><dt>Findings</dt><dd>{values.findings.length === 0 ? "None yet" : approvedCount === values.findings.length ? `${values.findings.length}, all approved` : `${approvedCount} of ${values.findings.length} approved`}</dd></div>
            <div><dt>Photographs</dt><dd>{usedPhotos.length}</dd></div>
            <div><dt>Opinion</dt><dd>{isOpinionApproved(values) ? 'Approved' : values.opinion.trim() ? 'Not approved yet' : 'Not written yet'}</dd></div>
          </dl>
          <div className="qt-nav">
            <Button type="button" variant="secondary" onClick={() => goTo(2)}>Back to conclusion</Button>
            {docId ? (
              problems.length ? (
                <Link className="btn btn-secondary" href={`/documents/${docId}`}>Open the draft page</Link>
              ) : (
                <Button
                  type="button"
                  disabled={starting}
                  onClick={async () => {
                    setStarting(true);
                    await runSave();
                    window.location.assign(`/documents/${docId}/preview`);
                  }}
                >
                  {starting ? 'Opening' : 'Preview and finalise'}
                </Button>
              )
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
