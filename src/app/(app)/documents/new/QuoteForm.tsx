'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../../components/Button';
import { CustomerStep } from '../../../../components/quote/CustomerStep';
import { JobStep, type NumberStatus } from '../../../../components/quote/JobStep';
import { PlanStep } from '../../../../components/quote/PlanStep';
import { PriceStep } from '../../../../components/quote/PriceStep';
import { ReviewStep } from '../../../../components/quote/ReviewStep';
import { TotalsBar } from '../../../../components/quote/TotalsBar';
import type { StepProps } from '../../../../components/quote/types';
import type { QuoteContext } from '../../../../lib/data/quotes';
import { formatPct } from '../../../../lib/money';
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
import { checkNumberAction, finishQuoteAction, saveDraftAction } from './actions';

const STEP_LABEL: Record<QuoteStep, string> = { customer: 'Customer', job: 'Job', price: 'Price', plan: 'Plan', review: 'Review' };
const SAVE_DELAY_MS = 1200;
const CHECK_DELAY_MS = 500;

type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'error'; message: string };

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export function QuoteForm({
  ctx,
  initial,
  initialJobId,
}: {
  ctx: QuoteContext;
  initial: QuoteFormValues;
  initialJobId: string | null;
}) {
  const [values, setValues] = useState<QuoteFormValues>(initial);
  const [stepIx, setStepIx] = useState(0);
  const [reached, setReached] = useState(0);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState<ReadonlySet<QuoteStep>>(new Set());
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const [serverErrors, setServerErrors] = useState<QuoteErrors>({});
  const [numberStatus, setNumberStatus] = useState<NumberStatus>('idle');
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

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
    setValues((v) => ({ ...v, ...p }));
    setServerErrors((e) => (Object.keys(e).length ? {} : e));
  }, []);
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

  const goTo = (ix: number) => {
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

  const finish = async () => {
    if (blockers.length > 0) {
      setAttempted(new Set(QUOTE_STEPS));
      return;
    }
    setFinishing(true);
    setFinishError(null);
    await (inFlight.current ?? Promise.resolve());
    const res = await finishQuoteAction(claimed.current ? { ...valuesRef.current, ...claimed.current } : valuesRef.current, jobRef.current).catch(() => null);
    // A successful finish redirects, so only a refusal or a failure gets here.
    setFinishing(false);
    if (res && !res.ok) {
      if (res.errors) {
        setServerErrors(res.errors);
        setAttempted(new Set(QUOTE_STEPS));
      }
      setFinishError(res.message);
    } else if (!res) {
      setFinishError('We could not save that. Please try again.');
    }
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

  return (
    <div className="qt-form">
      <nav aria-label="Quote steps" className="qt-steps">
        <ol>
          {QUOTE_STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={`qt-stepbtn${i === stepIx ? ' is-now' : i < stepIx ? ' is-done' : ''}`}
                aria-current={i === stepIx ? 'step' : undefined}
                disabled={i > reached}
                onClick={() => goTo(i)}
              >
                <span className="qt-stepbar" aria-hidden="true" />
                <span className="qt-steplabel">{STEP_LABEL[s]}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <TotalsBar totals={totals} vatApplies={values.vatApplies} />

      <p className={`qt-save${save.kind === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite">{saveText}</p>

      <div ref={headingBox} className="qt-body">
        {step === 'customer' ? <CustomerStep {...stepProps} /> : null}
        {step === 'job' ? <JobStep {...stepProps} numberStatus={numberStatus} /> : null}
        {step === 'price' ? <PriceStep {...stepProps} vatRatePct={vatRatePct} /> : null}
        {step === 'plan' ? <PlanStep {...stepProps} /> : null}
        {step === 'review' ? <ReviewStep {...stepProps} blockers={blockers} goTo={(s) => goTo(QUOTE_STEPS.indexOf(s))} vatRatePct={vatRatePct} /> : null}
      </div>

      {finishError ? <p className="form-error" role="alert">{finishError}</p> : null}

      <div className="qt-nav">
        {stepIx > 0 ? (
          <Button type="button" variant="secondary" onClick={() => goTo(stepIx - 1)}>Back</Button>
        ) : (
          <span />
        )}
        {last ? (
          <Button type="button" onClick={finish} disabled={finishing || blockers.length > 0}>
            {finishing ? 'Saving' : 'Save quote'}
          </Button>
        ) : (
          <Button type="button" onClick={next}>Continue</Button>
        )}
      </div>
    </div>
  );
}
