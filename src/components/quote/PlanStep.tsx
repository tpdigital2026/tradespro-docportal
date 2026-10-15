'use client';

import {
  checkPlan,
  DEPOSIT_MAX_BP,
  DEPOSIT_MIN_BP,
  DEPOSIT_STEP_BP,
  formatGBP,
  formatPct,
  MAX_STAGES,
  MIN_STAGES,
  type PlanStage,
} from '../../lib/money';
import { bpToInput, parsePercentToBp, parsePoundsToPence, type PlanFormValues } from '../../lib/validation/quote';
import { Button } from '../Button';
import { Field } from '../Field';
import { MoneyField } from '../MoneyField';
import type { StepProps } from './types';

/** The stages that can be worked out so far, with where each one sat in the list. */
function readStages(stages: PlanFormValues['stages']): { stage: PlanStage; at: number }[] {
  const out: { stage: PlanStage; at: number }[] = [];
  stages.forEach((s, at) => {
    const label = s.label.trim() || `Stage ${at + 1}`;
    if (s.mode === 'pct') {
      const p = parsePercentToBp(s.value);
      if (p.ok && p.bp >= 1 && p.bp <= 9999) out.push({ stage: { label, mode: 'pct', pctBp: p.bp }, at });
    } else {
      const a = parsePoundsToPence(s.value);
      if (a.ok && a.pence >= 1) out.push({ stage: { label, mode: 'amount', grossPence: a.pence }, at });
    }
  });
  return out;
}

function evenSplit(n: number): string[] {
  const base = Math.floor(10_000 / n);
  return Array.from({ length: n }, (_, i) => bpToInput(i === n - 1 ? 10_000 - base * (n - 1) : base));
}

export function PlanStep({ values, set, err, touch, totals }: StepProps) {
  const plan = values.plan;
  const setPlan = (patch: Partial<PlanFormValues>) => set({ plan: { ...plan, ...patch } });
  const gross = totals.grossPence;
  const setStage = (i: number, patch: Partial<PlanFormValues['stages'][number]>) =>
    setPlan({ stages: plan.stages.map((s, k) => (k === i ? { ...s, ...patch } : s)) });

  // Deposit stepper
  const dep = parsePercentToBp(plan.depositPct);
  const depBp = dep.ok ? dep.bp : 3000;
  const nudge = (dir: 1 | -1) => {
    const snapped = dir === 1 ? Math.floor(depBp / DEPOSIT_STEP_BP) * DEPOSIT_STEP_BP + DEPOSIT_STEP_BP : Math.ceil(depBp / DEPOSIT_STEP_BP) * DEPOSIT_STEP_BP - DEPOSIT_STEP_BP;
    setPlan({ depositPct: bpToInput(Math.min(DEPOSIT_MAX_BP, Math.max(DEPOSIT_MIN_BP, snapped))) });
    touch('plan.depositPct');
  };
  const depSchedule = plan.kind === 'deposit' ? totals.schedule : null;

  // Staged running total, worked out from whatever has been typed so far
  const read = readStages(plan.stages);
  const partial = gross > 0 ? checkPlan(totals, { kind: 'staged', stages: read.map((r) => r.stage) }) : null;
  const perStage = new Map<number, number | null>();
  read.forEach((r, k) => perStage.set(r.at, partial?.declaredPerStage[k] ?? null));
  const allPct = plan.stages.length > 0 && plan.stages.every((s) => s.mode === 'pct');
  const bpSum = allPct ? read.reduce((s, r) => s + (r.stage.mode === 'pct' ? r.stage.pctBp : 0), 0) : 0;
  const complete = read.length === plan.stages.length;
  const placed = partial?.declaredPence ?? 0;
  const remaining = gross - placed;
  const adds = plan.kind === 'staged' && !!totals.planCheck?.ok;
  const stagedBlock = err('plan');

  return (
    <section aria-labelledby="step-h" className="qt-step">
      <div className="qt-step-head">
        <h2 id="step-h" className="qt-h" tabIndex={-1}>How is it paid?</h2>
        <p className="qt-lede">Choose how the customer pays. The invoices for this job follow the plan you pick.</p>
      </div>
      {gross <= 0 ? <p className="qt-warn">Enter the price first. The plan is worked out from the job total.</p> : null}

      <fieldset className="qt-plans">
        <legend className="sr-only">Payment plan</legend>

        <label className={`qt-opt${plan.kind === 'deposit' ? ' is-on' : ''}`}>
          <input type="radio" name="plan" checked={plan.kind === 'deposit'} onChange={() => setPlan({ kind: 'deposit' })} />
          <span className="qt-opt-main">
            <span className="qt-opt-title">Deposit, then the balance</span>
            <span className="qt-opt-meta">A deposit invoice up front, then an invoice for the rest.</span>
          </span>
        </label>
        {plan.kind === 'deposit' ? (
          <div className="qt-panel">
            <div className="qt-dep">
              <Button type="button" variant="secondary" onClick={() => nudge(-1)} aria-label="Lower the deposit by half a percent" disabled={depBp <= DEPOSIT_MIN_BP}>
                &minus;
              </Button>
              <Field announce={false}
                id="deposit-pct"
                label="Deposit, percent of the total"
                hint="Any whole or half percent from 1 to 99."
                inputMode="decimal"
                autoComplete="off"
                value={plan.depositPct}
                onChange={(e) => setPlan({ depositPct: e.target.value })}
                onBlur={() => touch('plan.depositPct')}
                error={err('plan.depositPct') ?? (stagedBlock && plan.kind === 'deposit' ? stagedBlock : undefined)}
                maxLength={7}
              />
              <Button type="button" variant="secondary" onClick={() => nudge(1)} aria-label="Raise the deposit by half a percent" disabled={depBp >= DEPOSIT_MAX_BP}>
                +
              </Button>
            </div>
            {depSchedule ? (
              <dl className="qt-sum">
                {depSchedule.map((i) => (
                  <div key={i.index}><dt>{i.label}</dt><dd>{formatGBP(i.grossPence)}</dd></div>
                ))}
                <div className="is-total"><dt>Total</dt><dd>{formatGBP(gross)}</dd></div>
              </dl>
            ) : null}
          </div>
        ) : null}

        <label className={`qt-opt${plan.kind === 'full' ? ' is-on' : ''}`}>
          <input type="radio" name="plan" checked={plan.kind === 'full'} onChange={() => setPlan({ kind: 'full' })} />
          <span className="qt-opt-main">
            <span className="qt-opt-title">Pay in full</span>
            <span className="qt-opt-meta">One invoice for the whole job. No deposit.</span>
          </span>
        </label>
        {plan.kind === 'full' ? (
          <div className="qt-panel">
            <dl className="qt-sum">
              <div className="is-total"><dt>One invoice for</dt><dd>{formatGBP(gross)}</dd></div>
            </dl>
          </div>
        ) : null}

        <label className={`qt-opt${plan.kind === 'staged' ? ' is-on' : ''}`}>
          <input type="radio" name="plan" checked={plan.kind === 'staged'} onChange={() => setPlan({ kind: 'staged' })} />
          <span className="qt-opt-main">
            <span className="qt-opt-title">Stage payments</span>
            <span className="qt-opt-meta">{MIN_STAGES} to {MAX_STAGES} payments at points you choose, like the scaffold coming down.</span>
          </span>
        </label>
        {plan.kind === 'staged' ? (
          <div className="qt-panel">
            <p className="hint">Stages are worked out in order. The last stage is paid whatever is left, so what you enter for it must match what remains.</p>
            <ul className="qt-stages">
              {plan.stages.map((s, i) => {
                const worth = perStage.get(i);
                const problem = err(`plan.stages.${i}`);
                return (
                  <li key={i} className="qt-stage">
                    <Field announce={false}
                      id={`stage-l-${i}`}
                      label={`Stage ${i + 1} name`}
                      placeholder="For example, Scaffold up and strip complete"
                      autoComplete="off"
                      value={s.label}
                      onChange={(e) => setStage(i, { label: e.target.value })}
                      onBlur={() => touch(`plan.stages.${i}.label`)}
                      error={err(`plan.stages.${i}.label`)}
                      maxLength={160}
                    />
                    <div className="qt-stage-amt">
                      <div className="qt-mode" role="group" aria-label={`Stage ${i + 1} is set by`}>
                        <button type="button" className={s.mode === 'pct' ? 'is-on' : undefined} aria-pressed={s.mode === 'pct'} onClick={() => s.mode !== 'pct' && setStage(i, { mode: 'pct', value: '' })}>
                          Percent
                        </button>
                        <button type="button" className={s.mode === 'amount' ? 'is-on' : undefined} aria-pressed={s.mode === 'amount'} onClick={() => s.mode !== 'amount' && setStage(i, { mode: 'amount', value: '' })}>
                          Amount
                        </button>
                      </div>
                      {s.mode === 'pct' ? (
                        <Field announce={false}
                          id={`stage-v-${i}`}
                          label={`Stage ${i + 1} percent`}
                          inputMode="decimal"
                          autoComplete="off"
                          value={s.value}
                          onChange={(e) => setStage(i, { value: e.target.value })}
                          onBlur={() => touch(`plan.stages.${i}.value`)}
                          error={err(`plan.stages.${i}.value`)}
                          maxLength={7}
                        />
                      ) : (
                        <MoneyField announce={false}
                          id={`stage-v-${i}`}
                          label={`Stage ${i + 1} amount, with VAT`}
                          value={s.value}
                          onChange={(e) => setStage(i, { value: e.target.value })}
                          onBlur={() => touch(`plan.stages.${i}.value`)}
                          error={err(`plan.stages.${i}.value`)}
                          maxLength={34}
                        />
                      )}
                    </div>
                    <p className="qt-stage-worth">{typeof worth === 'number' ? `Works out at ${formatGBP(worth)}` : 'Not worked out yet'}</p>
                    {problem ? <p className="error">{problem}</p> : null}
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setPlan({ stages: plan.stages.filter((_, k) => k !== i) })}
                      disabled={plan.stages.length <= MIN_STAGES}
                      aria-label={`Remove stage ${i + 1}`}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
            <div className="qt-stage-actions">
              <Button type="button" variant="secondary" disabled={plan.stages.length >= MAX_STAGES} onClick={() => setPlan({ stages: [...plan.stages, { label: '', mode: 'pct', value: '' }] })}>
                Add a stage
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  const vals = evenSplit(plan.stages.length);
                  setPlan({ stages: plan.stages.map((s, k) => ({ ...s, mode: 'pct', value: vals[k] })) });
                }}
              >
                Share equally
              </Button>
            </div>

            <div className={`qt-run${adds ? ' is-ok' : gross > 0 && complete && remaining !== 0 ? ' is-off' : ''}`} role="status" aria-live="polite">
              <p className="qt-run-main">
                Placed {formatGBP(placed)} of {formatGBP(gross)}
                {allPct && read.length > 0 ? <span> ({formatPct(bpSum)}% of 100%)</span> : null}
              </p>
              <p className="qt-run-sub">
                {adds
                  ? 'The stages add up to the job total.'
                  : gross <= 0
                    ? 'Enter the price to see the job total.'
                    : !complete
                      ? 'Fill in every stage to see if they add up.'
                      : remaining > 0
                        ? `${formatGBP(remaining)} still to place.`
                        : remaining < 0
                          ? `${formatGBP(-remaining)} over the job total.`
                          : 'Fix the stages marked above.'}
              </p>
              {!adds && gross > 0 ? <p className="qt-run-block">You cannot continue until the stages add up to {formatGBP(gross)} exactly.</p> : null}
            </div>
            {stagedBlock ? <p className="error">{stagedBlock}</p> : null}
          </div>
        ) : null}
      </fieldset>
    </section>
  );
}
