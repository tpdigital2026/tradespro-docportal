import { DocTypeList } from '../../components/DocTypeList';
import { JobRow, type Job } from '../../components/JobRow';
import { demoJobs, demoRecentDocs, type DemoRecentDoc } from '../../lib/demo-data';
import { isDemo } from '../../lib/demo';
import { byUrgency, type DocType } from '../../lib/job-stage';
import { requireSession } from '../../lib/session';

const TYPE_NAMES: Record<DocType, string> = {
  quotation: 'Quotation',
  'deposit-invoice': 'Deposit invoice',
  'balance-invoice': 'Balance invoice',
  receipt: 'Receipt',
  guarantee: 'Guarantee certificate',
  survey: 'Survey report',
};

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default async function Home() {
  const session = await requireSession();
  const demo = isDemo();
  // Real job and document reads arrive with the data layer; until then only demo mode has rows.
  const jobs: Job[] = demo ? byUrgency(demoJobs) : [];
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

      <section className="home-section">
        <DocTypeList />
      </section>

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
                <p className="recent-type">{TYPE_NAMES[d.type]}</p>
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
