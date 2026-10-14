import Link from 'next/link';
import { DocTypeList } from '../../components/DocTypeList';
import { JobRow, type Job } from '../../components/JobRow';
import { demoRecentDocs, type DemoRecentDoc } from '../../lib/demo-data';
import { isDemo } from '../../lib/demo';
import { byUrgency, DOC_TYPE_NAMES } from '../../lib/job-stage';
import { listJobSummaries } from '../../lib/data/billing';
import { listDraftQuotes, type DraftListItem } from '../../lib/data/quotes';
import { requireSession } from '../../lib/session';

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

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
  const recent: DemoRecentDoc[] = demo ? demoRecentDocs : [];
  const firstName = session.fullName.split(' ')[0];

  return (
    <div className="page page-wide">
      <header className="home-head">
        <p className="eyebrow">{demo ? 'Demo mode, dummy data' : `Hello, ${firstName}`}</p>
        <h1>
          <span className="muted">Let&rsquo;s make some money.</span>
          What documents do you need?
        </h1>
      </header>

      {saved ? (
        <p className="cust-flash" role="status">Quote {saved} is saved. You can carry on with it below.</p>
      ) : null}

      <section className="home-section">
        <DocTypeList />
      </section>

      {drafts.length > 0 ? (
        <section aria-labelledby="drafts-h" className="home-section">
          <h2 id="drafts-h" className="section-title">Quotes to finish</h2>
          <p className="section-sub">Drafts save as you type. Pick one up where you left off.</p>
          <ul className="rows">
            {drafts.map((d) => (
              <li key={d.jobId}>
                <Link href={`/documents/new?type=quotation&draft=${d.jobId}`} className="cust-row">
                  <span className="cust-main">
                    <span className="row-title">{d.customerName}</span>
                    <span className="row-meta">Quote {d.quoteNumber}</span>
                  </span>
                  <span className="cust-kept">Continue</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="jobs-h" className="home-section">
        <h2 id="jobs-h" className="section-title">Jobs in progress</h2>
        <p className="section-sub">What is next for each job, with the most urgent first.</p>
        {jobs.length ? (
          <ul className="jobs">
            {jobs.map((j, i) => (
              <JobRow key={j.quoteNumber} job={j} primary={i === 0} />
            ))}
          </ul>
        ) : (
          <p className="empty">No jobs yet. Send a quotation and the next step for that job shows up here.</p>
        )}
      </section>

      <section aria-labelledby="recent-h" className="home-section">
        <h2 id="recent-h" className="section-title">Recent documents</h2>
        {recent.length ? (
          <ul className="recent">
            {recent.map((d) => (
              <li key={d.number} className="recent-row">
                <p className="recent-type">{DOC_TYPE_NAMES[d.type]}</p>
                <p className="recent-num">{d.number}</p>
                <p className="recent-who">{d.customerName}</p>
                <p className="recent-date">{dateFmt.format(new Date(d.date))}</p>
                <p className={`recent-status${d.status === 'Draft' ? ' is-draft' : ''}`}>{d.status}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Documents you make are listed here.</p>
        )}
      </section>
    </div>
  );
}
