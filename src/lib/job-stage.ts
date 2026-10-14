/** Where a job is in its paperwork. Pure: no I/O, no money. */

export const STAGES = [
  'quoted',
  'deposit-invoiced',
  'deposit-paid',
  'balance-invoiced',
  'paid-in-full',
  'guarantee-issued',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  quoted: 'Quoted',
  'deposit-invoiced': 'Deposit invoiced',
  'deposit-paid': 'Deposit paid',
  'balance-invoiced': 'Balance invoiced',
  'paid-in-full': 'Paid in full',
  'guarantee-issued': 'Guarantee issued',
};

export const DOC_TYPES = [
  'quotation',
  'deposit-invoice',
  'balance-invoice',
  'receipt',
  'guarantee',
  'survey',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

export type NextStep = { label: string; type: DocType };

const NEXT: Record<Stage, NextStep | null> = {
  quoted: { label: 'Raise deposit invoice', type: 'deposit-invoice' },
  'deposit-invoiced': { label: 'Record deposit receipt', type: 'receipt' },
  'deposit-paid': { label: 'Raise balance invoice', type: 'balance-invoice' },
  'balance-invoiced': { label: 'Issue receipt, paid in full', type: 'receipt' },
  'paid-in-full': { label: 'Issue guarantee certificate', type: 'guarantee' },
  'guarantee-issued': null,
};

export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage);
}

export function nextStep(stage: Stage): NextStep | null {
  return NEXT[stage];
}

export function newDocumentHref(type: DocType, job?: string): string {
  const q = new URLSearchParams({ type });
  if (job) q.set('job', job);
  return `/documents/new?${q.toString()}`;
}

/** Jobs furthest from done come first, so the most urgent paperwork leads. */
export function byUrgency<T extends { stage: Stage }>(jobs: T[]): T[] {
  return [...jobs]
    .filter((j) => nextStep(j.stage) !== null)
    .sort((a, b) => stageIndex(a.stage) - stageIndex(b.stage));
}
