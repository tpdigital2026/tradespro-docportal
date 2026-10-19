'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../../components/Button';
import { CustomerStep } from '../../../../components/quote/CustomerStep';
import { JobStep, type NumberStatus } from '../../../../components/quote/JobStep';
import { PlanStep } from '../../../../components/quote/PlanStep';
import { PriceStep } from '../../../../components/quote/PriceStep';
import { ReviewStep } from '../../../../components/quote/ReviewStep';
import { ScopeStep } from '../../../../components/quote/ScopeStep';
import { TotalsBar } from '../../../../components/quote/TotalsBar';
import type { StepProps } from '../../../../components/quote/types';
import type { QuoteContext } from '../../../../lib/data/quotes';
import { formatPct } from '../../../../lib/money';
import { applyJobTypeDefaults } from '../../../../lib/scope/defaults';
import { approvalState, isApproved, withoutApproval } from '../../../../lib/scope/model';
import { v2OnlyKey } from '../../../../lib/scope/approval';
import { computeQuoteTotals } from '../../../../lib/quote-totals';
import {
  normaliseQuote,
  NUMBER_RE,
  QUOTE_STEPS,
  stepOfError,
  type QuoteErrors,
  type QuoteFormValues,
  type QuoteStep,
} from '../../../../lib/validation/quote';
import { checkNumberAction, finishQuoteAction, saveDraftAction, saveForLaterAction, type FinishResult, type FixTarget } from './actions';
import { FinishPanel, type Outcome } from './FinishPanel';
import '../../../../styles/finish.css';

const STEP_LABEL: Record<QuoteStep, string> = { customer: 'Customer', job: 'Job', scope: 'Scope', price: 'Price', plan: 'Plan', review: 'Review' };
const SAVE_DELAY_MS = 1200;
const CHECK_DELAY_MS = 500;
/** A save that has not answered by now is reported, never left spinning. */
const FINISH_TIMEOUT_MS = 45_000;

type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'error'; message: string };

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export function QuoteForm({
  ctx,
  initial,
  initialJobId,
  initialStep,
}: {
  ctx: QuoteContext;
  initial: QuoteFormValues;
  initialJobId: string | null;
  /** Where Edit on the draft page lands: the first step with something missing, else the review. */
  initialStep?: QuoteStep;
}) {
  const startIx = initialStep && initialJobId ? Math.max(0, QUOTE_STEPS.indexOf(initialStep)) : 0;
  const [values, setValues] = useState<QuoteFormValues>(initial);
  const [stepIx, setStepIx] = useState(startIx);
  const [reached, setReached] = useState(startIx);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState<ReadonlySet<QuoteStep>>(new Set());
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const [serverErrors, setServerErrors] = useState<QuoteErrors>({});
  const [numberStatus, setNumberStatus] = useState<NumberStatus>('idle');
  const [reverted, setReverted] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [scopeView, setScopeView] = useState<'review' | undefined>(undefined);
  const router = useRouter();

  const rev = useRef(0);
  const savedRev = useRef(0);
  const jobRef = useRef<string | null>(initialJobId);
  const claimed = useRef<{ quoteNumber: string; customerId: string } | null>(initialJobId ? { quoteNumber: initial.quoteNumber, customerId: initial.customerId } : null);
  const valuesRef = useRef(values);
  const inFlight = useRef<Promise<void> | null>(null);
  const headingBox = useRef<HTMLDivElement>(null);
  const focusAfter = useRef(false);
  valuesRef.current = values;

  const vatRateBp = ctx.defaults.vatRateBp;
  const vatRatePct = formatPct(vatRateBp);
  const locked = jobId !== null;
  const step = QUOTE_STEPS[stepIx];

  const norm = useMemo(() => normaliseQuote(values, 'final', vatRateBp), [values, vatRateBp]);
  const totals = useMemo(() => computeQuoteTotals(norm.input, vatRateBp), [norm, vatRateBp]);
  const errors = useMemo<QuoteErrors>(() => ({ ...norm.errors, ...serverErrors }), [norm, serverErrors]);

  const patch = useCallback((p: Partial<QuoteFormValues>) => {
    rev.current += 1;
    setValues((v) => {
      const next = { ...v, ...p };
      // A new kind of job brings its own suggested title and introduction, unless the owner has written their own.
      if (p.jobTypeId !== undefined && p.jobTypeId !== v.jobTypeId) next.scope = applyJobTypeDefaults(next.scope, ctx.jobTypes, v.jobTypeId, p.jobTypeId);
      // Approval holds only while the steps, wording and note are exactly what was approved. Otherwise it is gone here too,
      // so the screen never shows an approval the server has already dropped.
      // An approval from before 15 October stays (so the server can check and upgrade it) only while nothing it covers
      // or the cover, introduction and key figures have changed.
      const keepOld = approvalState(next.scope) === 'legacy' && approvalState(v.scope) === 'legacy' && v2OnlyKey(next.scope) === v2OnlyKey(v.scope);
      if (next.scope.copy?.approvedAt && !isApproved(next.scope) && !keepOld) next.scope = withoutApproval(next.scope);
      return next;
    });
    setServerErrors((e) => (Object.keys(e).length ? {} : e));
    // An old answer next to the button would now be misleading.
    setOutcome((o) => (o.kind === 'refused' ? { kind: 'idle' } : o));
  }, [ctx.jobTypes]);
  const touch = useCallback((key: string) => setTouched((t) => (t.has(key) ? t : new Set(t).add(key))), []);

  const err = (key: string): string | undefined => {
    const shown = touched.has(key) || attempted.has(stepOfError(key));
    return shown ? errors[key] : undefined;
  };

  // ---- is this quote number free? (the database is the final word, this is the early warning)
  useEffect(() => {
    if (locked) return;
    const n = values.quoteNumber.trim();
    if (!NUMBER_RE.test(n)) {
      setNumberStatus(n === '' ? 'idle' : 'invalid');
      return;
    }
    setNumberStatus('checking');
    let stale = false;
    const t = setTimeout(async () => {
      const r = await checkNumberAction(n).catch(() => ({ status: 'error' as const }));
      if (!stale) setNumberStatus(r.status === 'free' ? 'free' : r.status === 'taken' ? 'taken' : r.status === 'invalid' ? 'invalid' : 'error');
    }, CHECK_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [values.quoteNumber, locked]);

  // ---- autosave: through the owner's session, one at a time, never losing the newest edit
  const canSave = !errors.quoteNumber && !errors.customerId && values.quoteNumber.trim() !== '' && values.customerId !== '' && (locked || numberStatus === 'free' || numberStatus === 'error');

  const runSave = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const p = (async () => {
      try {
        // Keep going until nothing newer is waiting.
        while (savedRev.current !== rev.current) {
          const mine = rev.current;
          setSave({ kind: 'saving' });
          // Once a job exists its number and customer are fixed: never send a different one.
          const outgoing = claimed.current ? { ...valuesRef.current, ...claimed.current } : valuesRef.current;
          const res = await saveDraftAction(outgoing, jobRef.current).catch(() => null);
          if (!res) {
            setSave({ kind: 'error', message: 'Not saved. Check your connection. We will try again when you change something.' });
            return;
          }
          if (!res.ok) {
            if (res.code === 'number_used') setNumberStatus('taken');
            if (res.errors) setServerErrors(res.errors);
            setSave({ kind: 'error', message: res.message });
            return;
          }
          // Tell the owner when an edit to the number or customer made during the first save has been put back.
          const cur = valuesRef.current;
          setReverted(cur.quoteNumber !== res.quoteNumber || cur.customerId !== res.customerId);
          jobRef.current = res.jobId;
          claimed.current = { quoteNumber: res.quoteNumber, customerId: res.customerId };
          valuesRef.current = { ...valuesRef.current, ...claimed.current };
          // A correction from the stored job, not an edit: it must not start another save.
          setValues((v) => ({ ...v, quoteNumber: res.quoteNumber, customerId: res.customerId }));
          setJobId(res.jobId);
          savedRev.current = mine;
          setSave({ kind: 'saved', at: clock.format(new Date(res.savedAt)) });
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            if (url.searchParams.get('draft') !== res.jobId) {
              url.searchParams.set('type', 'quotation');
              url.searchParams.set('draft', res.jobId);
              url.searchParams.delete('customer');
              window.history.replaceState(null, '', url);
            }
          }
        }
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, []);

  useEffect(() => {
    if (savedRev.current === rev.current || !canSave) return;
    const t = setTimeout(() => void runSave(), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [values, canSave, runSave]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (savedRev.current !== rev.current && canSave) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [canSave]);

  // ---- moving between steps
  useEffect(() => {
    if (!focusAfter.current) return;
    focusAfter.current = false;
    const firstBad = attempted.has(step) && Object.keys(errors).some((k) => stepOfError(k) === step) ? document.querySelector<HTMLElement>('.qt-form [aria-invalid="true"]') : null;
    (firstBad ?? headingBox.current?.querySelector<HTMLElement>('h2'))?.focus();
  });

  const stepBlockers = (s: QuoteStep): string[] => {
    const keys = Object.keys(errors).filter((k) => stepOfError(k) === s);
    if (s === 'job' && !locked && (numberStatus === 'taken' || numberStatus === 'checking')) keys.push('quoteNumber');
    return keys;
  };

  const goTo = (ix: number, view?: 'review') => {
    setScopeView(view);
    focusAfter.current = true;
    setStepIx(ix);
    setReached((r) => Math.max(r, ix));
    window.scrollTo({ top: 0 });
  };

  const next = () => {
    if (stepBlockers(step).length > 0) {
      focusAfter.current = true;
      setAttempted((a) => new Set(a).add(step));
      // Re-render so the errors exist before focus moves.
      setStepIx((i) => i);
      return;
    }
    goTo(Math.min(stepIx + 1, QUOTE_STEPS.length - 1));
  };

  const blockers = useMemo(
    () =>
      Object.entries(errors)
        .map(([key, message]) => ({ step: stepOfError(key), key, message }))
        .sort((a, b) => QUOTE_STEPS.indexOf(a.step) - QUOTE_STEPS.indexOf(b.step)),
    [errors],
  );

  const outgoing = () => (claimed.current ? { ...valuesRef.current, ...claimed.current } : valuesRef.current);

  /** Runs a server action, but never for longer than FINISH_TIMEOUT_MS, and never throws. */
  const call = async (fn: typeof finishQuoteAction): Promise<FinishResult | 'timeout' | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), FINISH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([fn(outgoing(), jobRef.current).catch(() => null), late]);
    } finally {
      clearTimeout(timer);
    }
  };

  const submit = async (which: 'preview' | 'later') => {
    if (outcome.kind === 'pending' || outcome.kind === 'saved') return;
    // Things the screen already knows are missing: say exactly what, with a way to each, without a round trip.
    // The approval is the exception: the server may be able to check an older one and upgrade it.
    const known = which === 'preview' ? blockers.filter((b) => b.key !== 'scope.approval') : [];
    if (known.length > 0) {
      setAttempted(new Set(QUOTE_STEPS));
      setOutcome({ kind: 'refused', which, saved: jobRef.current !== null, message: known.length === 1 ? 'One thing needs fixing before the preview.' : `${known.length} things need fixing before the preview.`, items: known.map((b) => ({ key: b.key, step: b.step, message: b.message })), diag: 'QF-SCREEN' });
      return;
    }
    if (which === 'later' && !canSave) {
      setOutcome({ kind: 'refused', which, saved: false, message: 'Nothing was saved because the quote has no customer or quote number yet.', fix: { step: values.customerId ? 'job' : 'customer', label: values.customerId ? 'Open the Job step' : 'Open the Customer step' }, diag: 'QL-SCREEN' });
      return;
    }
    setOutcome({ kind: 'pending', which });
    await (inFlight.current ?? Promise.resolve()).catch(() => undefined);
    const sentRev = rev.current;
    const res = await call(which === 'preview' ? finishQuoteAction : saveForLaterAction);
    if (res === 'timeout') {
      setOutcome({ kind: 'refused', which, saved: false, message: 'This is taking far too long, so we stopped waiting. It may not have saved. Check your signal and try again.', diag: 'QF-TIMEOUT' });
      return;
    }
    if (!res) {
      setOutcome({ kind: 'refused', which, saved: false, message: 'Nothing was saved because we could not reach the server. Check your signal and try again.', diag: 'QF-NETWORK' });
      return;
    }
    if (res.jobId && res.quoteNumber && res.customerId) {
      jobRef.current = res.jobId;
      claimed.current = { quoteNumber: res.quoteNumber, customerId: res.customerId };
      setJobId(res.jobId);
    }
    if (res.ok) {
      // What was just saved is the newest: nothing is waiting, so leaving the page does not warn.
      if (rev.current === sentRev) savedRev.current = sentRev;
      setSave({ kind: 'saved', at: clock.format(new Date(res.savedAt)) });
      setOutcome({ kind: 'saved', which, href: res.href });
      router.push(res.href);
      return;
    }
    if (res.code === 'number_used') setNumberStatus('taken');
    if (res.errors) {
      setServerErrors(res.errors);
      setAttempted(new Set(QUOTE_STEPS));
    }
    setOutcome({ kind: 'refused', which, saved: res.saved, message: res.message, fix: res.fix, diag: res.diag });
  };

  const fixIt = (f: Pick<FixTarget, 'step' | 'scopeView'>) => {
    setOutcome({ kind: 'idle' });
    goTo(QUOTE_STEPS.indexOf(f.step), f.scopeView);
  };

  // The price opens only once the wording is approved. Changing the steps afterwards closes it again.
  const scopeIx = QUOTE_STEPS.indexOf('scope');
  const scopeOk = isApproved(values.scope);
  const reachable = scopeOk ? reached : Math.min(reached, scopeIx);

  const ensureSaved = async (): Promise<string | null> => {
    if (canSave) await runSave();
    return jobRef.current;
  };

  const stepProps: StepProps = { values, set: patch, err, touch, ctx, totals, locked };
  const last = stepIx === QUOTE_STEPS.length - 1;
  const saveText =
    save.kind === 'saving'
      ? 'Saving the draft'
      : save.kind === 'saved'
        ? `Draft saved at ${save.at}`
        : save.kind === 'error'
          ? save.message
          : canSave
            ? 'The draft saves as you go.'
            : 'The draft starts saving once you have chosen a customer and a quote number.';

  const chosen = ctx.customers.find((c) => c.id === values.customerId);
  const summaryCustomer = chosen ? { name: chosen.name, address: [chosen.addressLine, chosen.postcode].filter(Boolean).join(', ') } : null;
  const summaryType = ctx.jobTypes.find((t) => t.id === values.jobTypeId)?.label ?? null;

  return (
    <div className={`qt-form${step === 'scope' ? ' is-scope' : ''}`}>
      <nav aria-label="Quote steps" className="qt-steps">
        <p className="qt-steps-now" aria-hidden="true">
          Step {stepIx + 1} of {QUOTE_STEPS.length}: <strong>{STEP_LABEL[step]}</strong>
        </p>
        <ol>
          {QUOTE_STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={`qt-stepbtn${i === stepIx ? ' is-now' : i < stepIx ? ' is-done' : ''}`}
                aria-current={i === stepIx ? 'step' : undefined}
                disabled={i > reachable}
                onClick={() => goTo(i)}
              >
                <span className="qt-stepnum" aria-hidden="true">
                  {i < stepIx ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="qt-steplabel">{STEP_LABEL[s]}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div className="qt-layout">
        <div className="qt-main">
          <p className={`qt-save${save.kind === 'error' ? ' is-error' : save.kind === 'saved' ? ' is-saved' : ''}`} role="status" aria-live="polite">{saveText}</p>

          {reverted ? <p className="qt-save" role="status" aria-live="polite">The quote number and customer are fixed once saved.</p> : null}

          <div ref={headingBox} className="qt-body">
            {step === 'customer' ? <CustomerStep {...stepProps} /> : null}
            {step === 'job' ? <JobStep {...stepProps} numberStatus={numberStatus} /> : null}
            {step === 'scope' ? <ScopeStep {...stepProps} startView={scopeView} ensureSaved={ensureSaved} onBack={() => goTo(stepIx - 1)} onContinue={() => goTo(stepIx + 1)} /> : null}
            {step === 'price' ? <PriceStep {...stepProps} vatRatePct={vatRatePct} /> : null}
            {step === 'plan' ? <PlanStep {...stepProps} /> : null}
            {step === 'review' ? <ReviewStep {...stepProps} blockers={blockers} goTo={(s) => goTo(QUOTE_STEPS.indexOf(s), s === 'scope' && approvalState(values.scope) !== 'none' ? 'review' : undefined)} vatRatePct={vatRatePct} /> : null}
          </div>

          {step !== 'scope' && stepIx > 0 ? (
            <div className="qt-nav">
              <Button type="button" variant="secondary" onClick={() => goTo(stepIx - 1)}>Back to {STEP_LABEL[QUOTE_STEPS[stepIx - 1]].toLowerCase()}</Button>
            </div>
          ) : null}
        </div>

        {step === 'scope' ? null : (
          <aside className="qt-side" aria-label="Quote summary">
            <TotalsBar
              totals={totals}
              vatApplies={values.vatApplies}
              quoteNumber={values.quoteNumber.trim()}
              customer={summaryCustomer}
              jobType={summaryType}
              planKind={values.plan.kind}
            >
              {last ? (
                <FinishPanel outcome={outcome} onPreview={() => void submit('preview')} onLater={() => void submit('later')} onFix={fixIt} />
              ) : (
                <Button type="button" onClick={next}>Continue to {STEP_LABEL[QUOTE_STEPS[stepIx + 1]].toLowerCase()}</Button>
              )}
            </TotalsBar>
          </aside>
        )}
      </div>
    </div>
  );
}
