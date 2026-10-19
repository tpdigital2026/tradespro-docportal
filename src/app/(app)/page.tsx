import type { Metadata } from 'next';
import Link from 'next/link';
import { DocTypeIcon } from '../../components/DocTypeIcon';
import { DocTypeList } from '../../components/DocTypeList';
import { EmptyState } from '../../components/EmptyState';
import { HomeHero } from '../../components/HomeHero';
import { JobRow, type Job } from '../../components/JobRow';
import { MoneyStrip } from '../../components/MoneyStrip';
import { getTenantBrand } from '../../lib/brand';
import { isDemo } from '../../lib/demo';
import { initials } from '../../lib/initials';
import { byUrgency, DOC_TYPE_NAMES, isInvoiceType } from '../../lib/job-stage';
import { listJobSummaries } from '../../lib/data/billing';
import { listDraftQuotes, type DraftListItem } from '../../lib/data/quotes';
import { listLibrary, quoteDocumentIdFor, type LibraryItem } from '../../lib/data/documents';
import { requireSession } from '../../lib/session';
import { listSurveyedJobs } from '../../lib/data/survey-links';

export const metadata: Metadata = { title: 'Home', description: 'Start a document, pick up a draft and see what is next for each job.' };

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const sp = await searchParams;
  const savedRaw = sp.quote;
  const saved = typeof savedRaw === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{1,39}$/.test(savedRaw) ? savedRaw : null;
  let drafts: DraftListItem[] = [];
  try {
    drafts = await listDraftQuotes();
  } catch {
    drafts = [];
  }
  const demo = isDemo();
  let jobs: Job[] = [];
  try {
    const all = await listJobSummaries();
    jobs = byUrgency(
      all.flatMap((j) => (j.billing ? [{ quoteNumber: j.quoteNumber, customerName: j.customerName, addressLine: j.addressLine, progress: j.billing.progress }] : [])),
    );
  } catch {
    jobs = [];
  }
  // Surveyed jobs waiting for their quote come first: the quote is the next thing to write.
  jobs = [...(await listSurveyedJobs().catch(() => [])), ...jobs];
  let recent: LibraryItem[] = [];
  try {
    recent = (await listLibrary({ limit: 6 })).items;
  } catch {
    recent = [];
  }
  const savedDoc = saved ? await quoteDocumentIdFor(saved).catch(() => null) : null;
  const brand = await getTenantBrand(session.tenantId);
  const firstName = session.fullName.split(' ')[0];

  // Counts of the owner's own records, nothing more. Hidden entirely when there is nothing to count.
  const waiting = jobs.filter((j) => j.progress.next?.action === 'mark-paid').length;
  const toInvoice = jobs.filter((j) => j.progress.next?.action === 'create' && isInvoiceType(j.progress.next.type)).length;
  const counts = [
    { n: drafts.length, label: drafts.length === 1 ? 'quote to finish' : 'quotes to finish', href: '#drafts-h' },
    { n: jobs.length, label: jobs.length === 1 ? 'job in progress' : 'jobs in progress', href: '#jobs-h' },
    { n: toInvoice, label: 'ready to invoice', href: '#jobs-h' },
    { n: waiting, label: 'waiting for payment', href: '#jobs-h' },
  ];
  const anything = counts.some((c) => c.n > 0);

  return (
    <div className="home">
      <HomeHero brand={brand} hello={`Hello, ${firstName}`}>
        <span className="hero-lead">Let&rsquo;s make some money.</span>
        <span className="hero-ask">What documents do you need?</span>
      </HomeHero>

      <div className="home-body">
        {demo ? <p className="demo-chip">Demo mode. Everything here is dummy data.</p> : null}
        {saved ? (
          <p className="flash" role="status">
            <span>
              Quote {saved} is saved.{' '}
              {savedDoc ? <Link href={`/documents/${savedDoc}`} className="flash-link">Open it to preview and finalise</Link> : 'You can carry on with it under Quotes to finish.'}
            </span>
          </p>
        ) : null}

        <section aria-labelledby="docs-h" className="home-docs">
          <h2 id="docs-h" className="sr-only">Start a document</h2>
          <DocTypeList />
        </section>

        {anything ? (
          <nav aria-label="At a glance" className="glance">
            <ul>
              {counts.map((c) => (
                <li key={c.label} className={c.n === 0 ? 'is-zero' : undefined}>
                  <a href={c.href}>
                    <span className="glance-n">{c.n}</span>
                    <span className="glance-label">{c.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <MoneyStrip />

        <div className="home-lower">
          <section aria-labelledby="jobs-h" className="home-jobs">
            <div className="sec-head">
              <h2 id="jobs-h" className="section-title">Jobs in progress</h2>
              <p className="section-sub">The most urgent first, each with its next step.</p>
            </div>
            {jobs.length ? (
              <ul className="jobs">
                {jobs.map((j, i) => (
                  <JobRow key={j.quoteNumber} job={j} primary={i === 0} />
                ))}
              </ul>
            ) : (
              <EmptyState icon="jobs" title="No jobs on the go yet">
                When a quotation is issued, the job shows up here with what to do next: invoices, payments and receipts.
              </EmptyState>
            )}
          </section>

          <div className="home-side">
            <section aria-labelledby="drafts-h" className="side-panel">
              <div className="sec-head">
                <h2 id="drafts-h" className="section-title">Quotes to finish</h2>
                <p className="section-sub">{drafts.length ? `${plural(drafts.length, 'draft', 'drafts')}, saved as you typed.` : 'Drafts save as you type.'}</p>
              </div>
              {drafts.length ? (
                <ul className="mini-list">
                  {drafts.map((d) => (
                    <li key={d.jobId}>
                      <Link href={d.documentId ? `/documents/${d.documentId}` : `/documents/new?type=quotation&draft=${d.jobId}`} className="mini-row">
                        <span className="avatar" aria-hidden="true">{initials(d.customerName)}</span>
                        <span className="mini-main">
                          <span className="mini-title">{d.customerName}</span>
                          <span className="mini-meta">Quote {d.quoteNumber}</span>
                        </span>
                        <span className="mini-go">Open</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon="drafts" title="Nothing half finished" compact>
                  Start a quotation and stop whenever you like. It waits here until you come back.
                </EmptyState>
              )}
            </section>

            <section aria-labelledby="recent-h" className="side-panel">
              <div className="sec-head">
                <h2 id="recent-h" className="section-title">Recent documents</h2>
                <p className="section-sub">The newest first.</p>
                <Link href="/documents" className="see-all">See all documents</Link>
              </div>
              {recent.length ? (
                <ul className="mini-list">
                  {recent.map((d) => (
                    <li key={d.id}>
                      <Link href={`/documents/${d.id}`} className="mini-row">
                        <span className="doc-chip" aria-hidden="true"><DocTypeIcon type={d.type} /></span>
                        <span className="mini-main">
                          <span className="mini-title">{DOC_TYPE_NAMES[d.type]}</span>
                          <span className="mini-meta">{d.number} for {d.customerName}</span>
                        </span>
                        <span className="mini-end">
                          <span className={`status-chip ${d.status === 'draft' ? 'is-draft' : 'is-final'}`}>{d.status === 'draft' ? 'Draft' : 'Final'}</span>
                          <span className="mini-date">{dateFmt.format(new Date(d.date))}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon="docs" title="No documents yet" compact>
                  Everything you make is listed here, so you can find it again in a couple of taps.
                </EmptyState>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
