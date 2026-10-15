import type { Metadata } from 'next';
import Link from 'next/link';
import { ButtonLink } from '../../../components/Button';
import { EmptyState } from '../../../components/EmptyState';
import { PageHeader } from '../../../components/PageHeader';
import { ageText, buildPipeline, isStageKey, STAGES, type PipelineCard, type StageKey } from '../../../lib/business/pipeline';
import { overdueJobIds } from '../../../lib/business/money-board';
import { getBusinessFacts, JOB_LIMIT, type BusinessFacts } from '../../../lib/data/business';
import { isDemo } from '../../../lib/demo';
import { jobHref, nextStepHref } from '../../../lib/job-stage';
import { shortDate, todayLondon } from '../../../lib/london';
import { formatGBP } from '../../../lib/money';
import { requireSession } from '../../../lib/session';
import '../../../styles/business.css';

export const metadata: Metadata = { title: 'Pipeline', description: 'Every job by where its paperwork is up to, the most urgent first.' };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Card({ c, linkable, primary }: { c: PipelineCard; linkable: boolean; primary: boolean }) {
  const stageName = STAGES.find((s) => s.key === c.stage)?.label ?? '';
  return (
    <article className={`pl-card${c.overdue ? ' is-overdue' : ''}`} aria-label={`${c.customerName}, quote ${c.quoteNumber}`}>
      <h3 className="pl-name">
        {linkable ? <Link href={c.stage === 'surveyed' && c.next ? c.next.href : jobHref(c.quoteNumber)} className="pl-name-link">{c.customerName}</Link> : c.customerName}
      </h3>
      <p className="pl-ref">
        {c.valuePence !== null ? <strong className="pl-value">{formatGBP(c.valuePence)}</strong> : null}
        <span>Quote {c.quoteNumber}{c.valuePence === null ? ' (not issued yet)' : ''}</span>
      </p>
      {c.addressLine ? <p className="pl-addr">{c.addressLine}</p> : null}
      <p className="pl-stage">
        <span className={`pl-chip is-${c.stage}`}><span className="sr-only">Stage: </span>{c.stageLabel}</span>
        {c.overdue ? <span className="pl-chip is-overdue">Overdue</span> : null}
      </p>
      <p className="pl-age">
        {!c.since ? (
          'Date not recorded'
        ) : c.stage === 'guarantee' ? (
          <>Finished {shortDate(c.since)}</>
        ) : (
          <>
            <span className="sr-only">In {stageName} for </span>
            {c.ageDays === 0 ? 'Since today' : `${ageText(c.ageDays)}, since ${shortDate(c.since, c.since.slice(0, 4) !== todayLondon().slice(0, 4))}`}
          </>
        )}
      </p>
      {c.problem ? <p className="pl-problem">{c.problem}</p> : null}
      {c.next ? (
        <ButtonLink href={c.next.href} variant={primary ? 'primary' : 'secondary'} className="pl-go">
          {c.next.label}
        </ButtonLink>
      ) : c.problem ? null : (
        <p className="pl-done">All done</p>
      )}
    </article>
  );
}

function colTotal(col: { key: StageKey; totalPence: number; valued: number; cards: PipelineCard[] }) {
  if (col.cards.length === 0) return 'No jobs';
  if (col.valued === 0) return plural(col.cards.length, 'job');
  return `${plural(col.cards.length, 'job')}, quotes worth ${formatGBP(col.totalPence)}`;
}

export default async function PipelinePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const sp = await searchParams;
  const stageRaw = first(sp.stage);
  const stage: StageKey | null = isStageKey(stageRaw) ? stageRaw : null;
  const today = todayLondon();
  let facts: BusinessFacts | null = null;
  try {
    facts = await getBusinessFacts();
  } catch {
    facts = null;
  }
  const board = facts
    ? buildPipeline(facts.jobs, {
        today,
        overdueJobs: overdueJobIds(facts.jobs, today),
        hrefFor: nextStepHref,
        quoteHref: (j) => (j.draftQuoteId ? `/documents/new?type=quotation&draft=${encodeURIComponent(j.jobId)}` : '/documents/new?type=quotation'),
      })
    : null;
  const linkable = (c: PipelineCard) => !facts?.noJobPage.has(c.jobId) || c.stage === 'surveyed';
  const listed = board ? (stage ? board.cards.filter((c) => c.stage === stage) : board.cards) : [];
  const firstActionable = board?.cards.find((c) => c.next)?.jobId;

  return (
    <div className="page page-full">
      <PageHeader muted="Your" title="pipeline" lede="Every job by where its paperwork is up to. Overdue invoices first, then whatever has waited longest." />
      {isDemo() ? <p className="demo-chip">Demo mode. Everything here is dummy data.</p> : null}

      {!board ? (
        <p className="form-error" role="alert">We could not load your jobs just now. Please try again.</p>
      ) : board.cards.length === 0 ? (
        <EmptyState icon="jobs" title="No jobs on the board yet" action={<ButtonLink href="/documents/new?type=quotation">Start a quotation</ButtonLink>}>
          A job appears here once its survey or quotation is issued, then moves along as you invoice it, mark it paid and issue the guarantee.
        </EmptyState>
      ) : (
        <>
          {facts?.truncated ? <p className="lib-cap" role="note">Showing your newest {JOB_LIMIT} jobs.</p> : null}

          {/* Phone: one stage at a time, picked with chips. */}
          <div className="pl-phone">
            <nav aria-label="Filter by stage" className="lib-filters pl-filters">
              <ul>
                <li><Link href="/pipeline" className="filter-chip" aria-current={stage === null ? 'true' : undefined}>All <span className="pl-n">{board.cards.length}</span></Link></li>
                {board.columns.map((col) => (
                  <li key={col.key}>
                    <Link href={`/pipeline?stage=${col.key}`} className="filter-chip" aria-current={stage === col.key ? 'true' : undefined}>
                      {col.label} <span className="pl-n">{col.cards.length}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            {stage ? (
              <p className="pl-col-sum" role="status">{colTotal(board.columns.find((c) => c.key === stage)!)}</p>
            ) : (
              <p className="pl-col-sum" role="status">{plural(board.cards.length, 'job')}, the most urgent first</p>
            )}
            {listed.length ? (
              <ul className="pl-list">
                {listed.map((c) => (
                  <li key={c.jobId}><Card c={c} linkable={linkable(c)} primary={c.jobId === firstActionable} /></li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="jobs" title={`Nothing at ${STAGES.find((s) => s.key === stage)?.label ?? 'this stage'}`} compact>
                {STAGES.find((s) => s.key === stage)?.hint ?? ''}. Jobs show up here when they get to this stage.
              </EmptyState>
            )}
          </div>

          {/* Wider screens: the whole board, columns side by side. */}
          <section className="pl-board" aria-label="Pipeline board" tabIndex={0}>
            {board.columns.map((col) => (
              <section key={col.key} className={`pl-col is-${col.key}`} aria-labelledby={`col-${col.key}`}>
                <header className="pl-col-head">
                  <h2 id={`col-${col.key}`} className="pl-col-title">
                    {col.label} <span className="pl-n">{col.cards.length}</span>
                  </h2>
                  <p className="pl-col-total">{col.valued > 0 ? <>Quotes worth <strong>{formatGBP(col.totalPence)}</strong></> : col.hint}</p>
                </header>
                {col.cards.length ? (
                  <ul className="pl-col-list">
                    {col.cards.map((c) => (
                      <li key={c.jobId}><Card c={c} linkable={linkable(c)} primary={c.jobId === firstActionable} /></li>
                    ))}
                  </ul>
                ) : (
                  <p className="pl-col-empty">No jobs here right now.</p>
                )}
              </section>
            ))}
          </section>
          <p className="pl-foot">Values are the totals of the issued quotes, including VAT where it applies. Nothing is estimated.</p>
        </>
      )}
    </div>
  );
}
