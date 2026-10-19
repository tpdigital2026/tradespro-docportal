import type { Metadata } from 'next';
import Link from 'next/link';
import { JobsTable } from '../../components/JobsTable';
import { NewDocumentMenu } from '../../components/NewDocumentMenu';
import { PageHeader } from '../../components/PageHeader';
import { summariseInvoices } from '../../lib/business/money-board';
import { timeRange, type Appointment } from '../../lib/calendar/model';
import { getInvoiceTotals } from '../../lib/data/business';
import { isDemo } from '../../lib/demo';
import { buildHomeRows, homeFigures, latestByQuote, parseView, rowsFor, viewHref, type HomeView, type JobIn } from '../../lib/home-rows';
import { byUrgency, DOC_TYPE_NAMES } from '../../lib/job-stage';
import { listAppointments } from '../../lib/data/appointments';
import { listJobSummaries } from '../../lib/data/billing';
import { listDraftQuotes, type DraftListItem } from '../../lib/data/quotes';
import { listLibrary, quoteDocumentIdFor, type LibraryItem } from '../../lib/data/documents';
import { addDays, londonToUtc, todayLondon } from '../../lib/london';
import { requireSession } from '../../lib/session';
import { listSurveyedJobs } from '../../lib/data/survey-links';

export const metadata: Metadata = { title: 'Home', description: 'What needs doing next on each job, with every document a tap away.' };

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

async function todaysAppointments(): Promise<Appointment[]> {
  const today = todayLondon();
  const from = londonToUtc(today, '00:00');
  const to = londonToUtc(addDays(today, 1), '00:00');
  if (!from.ok || !to.ok) return [];
  return listAppointments(from.at, to.at).catch(() => []);
}

async function overdueInvoices(): Promise<number> {
  try {
    return summariseInvoices(await getInvoiceTotals(), todayLondon()).overdueInvoices;
  } catch {
    return 0;
  }
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const sp = await searchParams;
  const savedRaw = sp.quote;
  const saved = typeof savedRaw === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{1,39}$/.test(savedRaw) ? savedRaw : null;
  const view: HomeView = parseView(sp.view);
  const demo = isDemo();

  let drafts: DraftListItem[] = [];
  try {
    drafts = await listDraftQuotes();
  } catch {
    drafts = [];
  }
  let jobs: JobIn[] = [];
  try {
    const all = await listJobSummaries();
    jobs = byUrgency(all.flatMap((j) => (j.billing ? [{ quoteNumber: j.quoteNumber, customerName: j.customerName, addressLine: j.addressLine, progress: j.billing.progress }] : [])));
  } catch {
    jobs = [];
  }
  // Surveyed jobs waiting for their quote come first: the quote is the next thing to write.
  jobs = [...(await listSurveyedJobs().catch(() => [])), ...jobs];
  let library: LibraryItem[] = [];
  try {
    library = (await listLibrary({ limit: 200 })).items;
  } catch {
    library = [];
  }
  const recent = library.slice(0, 6);
  const [savedDoc, today, overdue] = await Promise.all([saved ? quoteDocumentIdFor(saved).catch(() => null) : null, todaysAppointments(), overdueInvoices()]);

  const rows = buildHomeRows(jobs, drafts, latestByQuote(library));
  const f = homeFigures(rows);
  const counts: Record<HomeView, number> = {
    action: rowsFor(rows, 'action').length,
    quotes: f.quotes,
    waiting: f.waiting,
    invoice: f.toInvoice,
    all: rows.length,
  };
  const figures: { n: number; label: string; view: HomeView; note?: string }[] = [
    { n: f.quotes, label: 'Quotes to finish', view: 'quotes' },
    { n: f.inProgress, label: 'Jobs in progress', view: 'all' },
    { n: f.toInvoice, label: 'Ready to invoice', view: 'invoice' },
    { n: f.waiting, label: 'Waiting for payment', view: 'waiting', note: overdue ? `${overdue} ${overdue === 1 ? 'invoice' : 'invoices'} overdue` : undefined },
  ];

  return (
    <div className="ws ws-home">
      <PageHeader title="Home" action={<NewDocumentMenu />} />

      {demo || saved ? (
        <div className="ws-notes">
          {demo ? <p className="demo-chip">Demo mode. Everything here is dummy data.</p> : null}
          {saved ? (
            <p className="flash" role="status">
              <span>
                Quote {saved} is saved.{' '}
                {savedDoc ? <Link href={`/documents/${savedDoc}`} className="flash-link">Open it to preview and finalise</Link> : 'You can carry on with it under Quotes to finish.'}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

      <nav aria-label="At a glance" className="figs">
        <ul>
          {figures.map((x) => (
            <li key={x.label}>
              <Link href={viewHref(x.view)} className="fig" aria-current={view === x.view && x.view !== 'all' ? 'true' : undefined}>
                <span className="fig-n">{x.n}</span>
                <span className="fig-label">{x.label}</span>
                {x.note ? <span className="fig-note">{x.note}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="home-grid">
        <JobsTable rows={rowsFor(rows, view)} view={view} counts={counts} />

        <div className="home-aside">
          {today.length ? (
            <section aria-labelledby="today-h" className="aside-sec">
              <div className="aside-head">
                <h2 id="today-h" className="ws-h3">Today</h2>
                <Link href="/calendar" className="ws-link">Calendar</Link>
              </div>
              <ul className="plain-list">
                {today.map((a) => (
                  <li key={a.id}>
                    <Link href={`/calendar/${a.id}`} className="plain-row is-time">
                      <span className="plain-time">{timeRange(a).slice(0, 5)}</span>
                      <span className="plain-main">
                        <span className="plain-title">{a.title}</span>
                        {a.customerName ? <span className="plain-meta">{a.customerName}</span> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="recent-h" className="aside-sec">
            <div className="aside-head">
              <h2 id="recent-h" className="ws-h3">Recent documents</h2>
              <Link href="/documents" className="ws-link">See all<span className="sr-only"> documents</span></Link>
            </div>
            {recent.length ? (
              <ul className="plain-list">
                {recent.map((d) => (
                  <li key={d.id}>
                    <Link href={`/documents/${d.id}`} className="plain-row">
                      <span className="plain-main">
                        <span className="plain-title">{DOC_TYPE_NAMES[d.type]}</span>
                        <span className="plain-meta">{d.number}, {d.customerName}</span>
                      </span>
                      <span className="plain-end">
                        <span className={`pill is-${d.status === 'draft' ? 'neutral' : 'blue'}`}>{d.status === 'draft' ? 'Draft' : 'Final'}</span>
                        <span className="plain-date">{dateFmt.format(new Date(`${d.date}T00:00:00Z`))}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="aside-empty">Documents you make are listed here.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
