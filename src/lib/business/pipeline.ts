/**
 * The Pipeline board: each job in the stage its paperwork has reached, worked out with deriveJobStage from recorded
 * facts. Pure.
 *
 * Columns (in order): Surveyed, Quoted, Invoiced (an invoice is out and not yet paid), Part paid (some instalments paid,
 * the next invoice not raised yet), Paid in full, Guarantee issued. Each card carries the exact step in words, so the
 * column colour is never the only signal. Job values are the issued quote's stored gross; column totals add those up
 * and nothing else.
 */
import { deriveJobStage, instalmentFromNumber, isInvoiceType, type JobProgress, type NextStep } from '../job-stage';
import { daysBetween, londonDate } from '../london';
import { isLive, type FactDocument, type JobFacts, type StoredInstalment } from './facts';

export const STAGES = [
  { key: 'surveyed', label: 'Surveyed', hint: 'Survey done, quote not issued yet' },
  { key: 'quoted', label: 'Quoted', hint: 'Quote issued, nothing invoiced yet' },
  { key: 'invoiced', label: 'Invoiced', hint: 'An invoice is out and not paid yet' },
  { key: 'part-paid', label: 'Part paid', hint: 'Paid so far, next invoice not raised' },
  { key: 'paid', label: 'Paid in full', hint: 'Every instalment paid' },
  { key: 'guarantee', label: 'Guarantee issued', hint: 'All done' },
] as const;

export type StageKey = (typeof STAGES)[number]['key'];
export const isStageKey = (s: unknown): s is StageKey => STAGES.some((x) => x.key === s);

export interface PipelineCard {
  jobId: string;
  quoteNumber: string;
  customerName: string;
  addressLine: string;
  stage: StageKey;
  /** The step in words, from deriveJobStage ("Stage 2 of 5 paid"), or "Surveyed". */
  stageLabel: string;
  /** The issued quote's stored gross; null before a quote is issued. */
  valuePence: number | null;
  /** yyyy-mm-dd the job reached this stage (London), or null when not recorded. */
  since: string | null;
  /** Whole days in this stage (0 = today). */
  ageDays: number | null;
  /** The one next step, or null when there is nothing left to do. */
  next: { label: string; href: string } | null;
  /** An issued invoice on this job is past its due date and not settled. */
  overdue: boolean;
  /** Something stopped the stage being worked out; said in words. */
  problem: string | null;
  progress: JobProgress | null;
}

export interface PipelineColumn {
  key: StageKey;
  label: string;
  hint: string;
  cards: PipelineCard[];
  /** Sum of the stored quote values of the cards that have one. */
  totalPence: number;
  /** How many cards have a quote value (the total covers these only). */
  valued: number;
}

/** The stage a job's progress is at, by the key of its current step. */
export function stageOf(progress: JobProgress): StageKey {
  const key = progress.steps[progress.currentIndex]?.key ?? 'quoted';
  if (key === 'quoted') return 'quoted';
  if (key === 'guarantee') return 'guarantee';
  const [kind, n] = key.split(':');
  if (kind === 'invoiced') return 'invoiced';
  const count = progress.steps.filter((s) => s.key.startsWith('paid:')).length;
  return Number(n) === count ? 'paid' : 'part-paid';
}

/** Instalments of a job's invoices and receipts, from their numbers (the same rule as everywhere else). */
export function instalmentOf(job: JobFacts, d: FactDocument, count: number): number | null {
  if (!job.planKind || d.type === 'quotation' || d.type === 'guarantee' || d.type === 'survey') return null;
  return instalmentFromNumber(d.type, d.number, job.quoteNumber, job.planKind, count);
}

/** deriveJobStage over the stored schedule. null when the job has no issued quote with a stored schedule. */
export function progressOf(job: JobFacts): { progress: JobProgress; schedule: StoredInstalment[] } | null {
  const schedule = job.quote?.schedule;
  if (!job.quote || !schedule || !job.planKind) return null;
  const count = schedule.length;
  const inst = new Map(job.documents.map((d) => [d.id, instalmentOf(job, d, count)]));
  const payments = job.payments.flatMap((p) => {
    const i = inst.get(p.documentId);
    return typeof i === 'number' ? [{ instalment: i, amountPence: p.amountPence, receiptLinked: p.receiptDocumentId !== null }] : [];
  });
  const documents = job.documents.map((d) => ({ type: d.type, instalment: inst.get(d.id) ?? null, status: d.status }));
  return { progress: deriveJobStage({ kind: job.planKind }, schedule, payments, documents), schedule };
}

const liveOf = (job: JobFacts, pred: (d: FactDocument) => boolean) =>
  job.documents.filter((d) => isLive(d.status) && pred(d)).sort((a, b) => String(a.finalisedAt).localeCompare(String(b.finalisedAt)));

/** When the job reached its current step, as a London date, from the recorded facts. */
export function enteredAt(job: JobFacts, progress: JobProgress, schedule: StoredInstalment[]): string | null {
  const key = progress.steps[progress.currentIndex]?.key ?? 'quoted';
  const day = (ts: string | null | undefined) => (ts ? londonDate(ts) : null);
  if (key === 'quoted') return day(job.quote?.issuedAt);
  if (key === 'guarantee') return day(liveOf(job, (d) => d.type === 'guarantee')[0]?.finalisedAt);
  const [kind, n] = key.split(':');
  const index = Number(n);
  const count = schedule.length;
  const invoice = liveOf(job, (d) => isInvoiceType(d.type) && instalmentOf(job, d, count) === index)[0];
  if (kind === 'invoiced') return day(invoice?.finalisedAt);
  // Paid: the date of the payment that brought the instalment up to its full amount.
  const gross = schedule.find((s) => s.index === index)?.grossPence ?? 0;
  const ids = new Set(liveOf(job, (d) => isInvoiceType(d.type) && instalmentOf(job, d, count) === index).map((d) => d.id));
  const pays = job.payments.filter((p) => ids.has(p.documentId)).sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.recordedAt.localeCompare(b.recordedAt));
  let sum = 0;
  for (const p of pays) {
    sum += p.amountPence;
    if (sum >= gross) return p.paidOn;
  }
  return null;
}

export interface CardOptions {
  today: string;
  /** Overdue job ids, from the Money rules (so both screens agree). */
  overdueJobs?: ReadonlySet<string>;
  /** Builds the link for a next step (kept out of here so this stays free of routing). */
  hrefFor: (step: NextStep, quoteNumber: string) => string;
  /** Where "Finish the quote" goes for a surveyed job. */
  quoteHref: (job: JobFacts) => string;
}

export function pipelineCard(job: JobFacts, o: CardOptions): PipelineCard | null {
  const base = {
    jobId: job.jobId,
    quoteNumber: job.quoteNumber,
    customerName: job.customerName,
    addressLine: job.addressLine,
    overdue: o.overdueJobs?.has(job.jobId) ?? false,
  };
  const age = (since: string | null) => (since ? Math.max(0, daysBetween(since, o.today)) : null);
  if (!job.quote) {
    const survey = liveOf(job, (d) => d.type === 'survey')[0];
    if (!survey) return null; // only a draft quote: it lives under "Quotes to finish" on Home
    const since = survey.finalisedAt ? londonDate(survey.finalisedAt) : null;
    return { ...base, stage: 'surveyed', stageLabel: 'Surveyed', valuePence: null, since, ageDays: age(since), next: { label: job.draftQuoteId ? 'Finish the quote' : 'Write the quote', href: o.quoteHref(job) }, problem: null, progress: null };
  }
  const p = progressOf(job);
  if (!p) {
    return {
      ...base,
      stage: 'quoted',
      stageLabel: 'Quoted',
      valuePence: job.quote.grossPence,
      since: londonDate(job.quote.issuedAt),
      ageDays: age(londonDate(job.quote.issuedAt)),
      next: null,
      problem: 'The payment plan was not stored with this quote, so its stage cannot be worked out. Open the job to check it.',
      progress: null,
    };
  }
  const since = enteredAt(job, p.progress, p.schedule);
  const step = p.progress.next;
  return {
    ...base,
    stage: stageOf(p.progress),
    stageLabel: p.progress.steps[p.progress.currentIndex].label,
    valuePence: job.quote.grossPence,
    since,
    ageDays: age(since),
    next: step ? { label: step.label, href: o.hrefFor(step, job.quoteNumber) } : null,
    problem: null,
    progress: p.progress,
  };
}

/**
 * Most urgent first: overdue invoices, then jobs with something to do, longest waiting first; finished jobs last.
 * Ties go by quote number so the order is stable.
 */
export function byPipelineUrgency(a: PipelineCard, b: PipelineCard): number {
  const rank = (c: PipelineCard) => (c.overdue ? 0 : c.problem ? 1 : c.next ? 2 : 3);
  return rank(a) - rank(b) || (b.ageDays ?? -1) - (a.ageDays ?? -1) || a.quoteNumber.localeCompare(b.quoteNumber, 'en', { numeric: true });
}

export function buildPipeline(jobs: JobFacts[], o: CardOptions): { columns: PipelineColumn[]; cards: PipelineCard[] } {
  const cards = jobs.flatMap((j) => {
    const c = pipelineCard(j, o);
    return c ? [c] : [];
  });
  cards.sort(byPipelineUrgency);
  const columns = STAGES.map((s) => {
    const mine = cards.filter((c) => c.stage === s.key);
    const valued = mine.filter((c) => c.valuePence !== null);
    return { key: s.key, label: s.label, hint: s.hint, cards: mine, totalPence: valued.reduce((t, c) => t + (c.valuePence as number), 0), valued: valued.length };
  });
  return { columns, cards };
}

/** "Today", "1 day", "12 days" */
export function ageText(days: number | null): string {
  if (days === null) return 'Date not recorded';
  if (days === 0) return 'Since today';
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
