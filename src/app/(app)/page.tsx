import { ButtonLink } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { demoCustomers, demoQuotes } from '../../lib/demo-data';
import { isDemo } from '../../lib/demo';
import { requireSession } from '../../lib/session';

// Placeholder Home. The real Home arrives in Task 6.
export default async function Home() {
  const session = await requireSession();
  if (!isDemo()) {
    return (
      <div className="page">
        <PageHeader muted="Ready when you are." title={`Hello, ${session.fullName}`} />
      </div>
    );
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="Demo mode"
        muted="Ready when you are."
        title="What are we quoting today?"
        action={<ButtonLink href="/documents/new" className="btn-block-sm">New document</ButtonLink>}
      />
      <h2 className="section-title">Recent</h2>
      <ul className="rows">
        {demoQuotes.map((q) => {
          const c = demoCustomers.find((x) => x.id === q.customerId);
          return (
            <li key={q.id} className="row">
              <div className="row-main">
                <p className="row-title">{q.quoteNumber}</p>
                <p className="row-meta">{c?.name}, {c?.addressLines[0]}</p>
              </div>
              <p className="row-tag">{q.status}</p>
            </li>
          );
        })}
      </ul>
      <p className="demo-note">Dummy data. Nothing here is real.</p>
    </div>
  );
}
