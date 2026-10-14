/** How a payment plan is stored on the job (jobs.payment_plan, jsonb, snake_case) and read back. Pure. */
import { z } from 'zod';
import { MAX_STAGES, MIN_STAGES, STAGE_LABEL_MAX, type Instalment, type PaymentPlan } from './money';

export interface StoredInstalment {
  index: number;
  label: string;
  net_pence: number;
  vat_pence: number;
  gross_pence: number;
}

export type StoredPlan =
  | { kind: 'deposit'; pct_bp: number; instalments?: StoredInstalment[] }
  | { kind: 'full'; instalments?: StoredInstalment[] }
  | { kind: 'staged'; stages: ({ label: string } & ({ mode: 'pct'; pct_bp: number } | { mode: 'amount'; gross_pence: number }))[]; instalments?: StoredInstalment[] };

const pence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instalment = z.object({ index: z.number().int().min(1).max(MAX_STAGES), label: z.string().min(1).max(STAGE_LABEL_MAX + 20), net_pence: pence, vat_pence: pence, gross_pence: pence });
const instalments = z.array(instalment).min(1).max(MAX_STAGES).optional();

const storedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deposit'), pct_bp: z.number().int().min(100).max(9900), instalments }),
  z.object({ kind: z.literal('full'), instalments }),
  z.object({
    kind: z.literal('staged'),
    stages: z
      .array(
        z.discriminatedUnion('mode', [
          z.object({ label: z.string().min(1).max(STAGE_LABEL_MAX), mode: z.literal('pct'), pct_bp: z.number().int().min(1).max(9999) }),
          z.object({ label: z.string().min(1).max(STAGE_LABEL_MAX), mode: z.literal('amount'), gross_pence: pence.min(1) }),
        ]),
      )
      .min(MIN_STAGES)
      .max(MAX_STAGES),
    instalments,
  }),
]);

function storeInstalments(list: Instalment[] | null | undefined): StoredInstalment[] | undefined {
  return list ? list.map((i) => ({ index: i.index, label: i.label, net_pence: i.netPence, vat_pence: i.vatPence, gross_pence: i.grossPence })) : undefined;
}

/** The jsonb to save. Pass the instalments only when the plan has been checked against the job's totals. */
export function planToJson(plan: PaymentPlan, instalments?: Instalment[] | null): StoredPlan {
  const inst = storeInstalments(instalments);
  const extra = inst ? { instalments: inst } : {};
  if (plan.kind === 'full') return { kind: 'full', ...extra };
  if (plan.kind === 'deposit') return { kind: 'deposit', pct_bp: plan.pctBp, ...extra };
  return {
    kind: 'staged',
    stages: plan.stages.map((s) => (s.mode === 'pct' ? { label: s.label, mode: 'pct' as const, pct_bp: s.pctBp } : { label: s.label, mode: 'amount' as const, gross_pence: s.grossPence })),
    ...extra,
  };
}

export interface ParsedStoredPlan {
  plan: PaymentPlan;
  instalments: Instalment[] | null;
}

/** Reads a stored plan back. Anything that does not match the shape reads as null, never throws. */
export function planFromJson(raw: unknown): ParsedStoredPlan | null {
  const r = storedSchema.safeParse(raw);
  if (!r.success) return null;
  const v = r.data;
  const inst = v.instalments ? v.instalments.map((i) => ({ index: i.index, label: i.label, netPence: i.net_pence, vatPence: i.vat_pence, grossPence: i.gross_pence })) : null;
  if (v.kind === 'full') return { plan: { kind: 'full' }, instalments: inst };
  if (v.kind === 'deposit') return { plan: { kind: 'deposit', pctBp: v.pct_bp }, instalments: inst };
  return {
    plan: { kind: 'staged', stages: v.stages.map((s) => (s.mode === 'pct' ? { label: s.label, mode: 'pct' as const, pctBp: s.pct_bp } : { label: s.label, mode: 'amount' as const, grossPence: s.gross_pence })) },
    instalments: inst,
  };
}
