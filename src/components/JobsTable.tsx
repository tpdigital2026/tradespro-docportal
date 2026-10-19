import Link from 'next/link';
import { DeleteDraft } from './DeleteDraft';
import { PendingHint } from './PendingHint';
import { HOME_LOAD_MESSAGES } from '../lib/home-load-messages';
import { HOME_VIEWS, viewHref, type HomeRow, type HomeView } from '../lib/home-rows';

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmt = (d: string | null) => (d ? dateFmt.format(new Date(`${d}T00:00:00Z`)) : '');

const EMPTY: Record<HomeView, string> = {
  action: 'Nothing needs you right now.',
  quotes: 'No quotes half finished.',
  waiting: 'Nobody owes you on an issued invoice.',
  invoice: 'No job is ready to invoice.',
  all: 'No jobs yet. Start a quotation from New document and it shows up here.',
};

/**
 * Home's main table. A real table (explicit roles, so the semantics survive the stacked phone layout). The customer
 * link stretches over the row, so the whole row opens the job; the next step sits above it. Only the first row's
 * next step is a filled button; the rest are text buttons.
 */
export function JobsTable({ rows, view, counts, loadFailed = false }: { rows: HomeRow[]; view: HomeView; counts: Record<HomeView, number>; loadFailed?: boolean }) {
  return (
    <section className="ws-surface jobs" aria-labelledby="jobs-h" id="jobs">
      <div className="jobs-head">
        <h2 id="jobs-h" className="ws-h2">Jobs</h2>
        <nav aria-label="Show jobs" className="ws-tabs">
          <ul>
            {HOME_VIEWS.map((v) => (
              <li key={v.key}>
                <Link href={viewHref(v.key)} className="ws-tab" aria-current={view === v.key ? 'page' : undefined} scroll={false}>
                  {v.label}
                  <span className="ws-tab-n">{counts[v.key]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      {view === 'invoice' ? (
        <p className="jobs-filter" role="status">
          Showing jobs ready to invoice. <Link href={viewHref('all')} className="ws-link">Show all jobs</Link>
        </p>
      ) : null}
      {loadFailed ? (
        <p className="jobs-empty" role="status">{HOME_LOAD_MESSAGES.jobs}</p>
      ) : null}
      {rows.length === 0 ? (
        loadFailed ? null :
        <p className="jobs-empty">{EMPTY[view]}</p>
      ) : (
        <table className="jobs-table" role="table">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Customer</th>
              <th role="columnheader" scope="col">Job</th>
              <th role="columnheader" scope="col">Stage</th>
              <th role="columnheader" scope="col">Next step</th>
              <th role="columnheader" scope="col" className="is-num">Updated</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((r, i) => (
              <tr key={r.key} role="row">
                <td role="cell" className="jt-customer">
                  <Link href={r.href} className="jt-open">{r.customer}<PendingHint /></Link>
                </td>
                <td role="cell" className="jt-job">
                  <span className="jt-ref">{r.job}</span>
                  {r.address ? <span className="jt-addr">{r.address}</span> : null}
                </td>
                <td role="cell" className="jt-stage">
                  <span className={`pill is-${r.tone}`}>{r.stage}</span>
                </td>
                <td role="cell" className="jt-next">
                  {r.next ? (
                    <Link href={r.next.href} className={i === 0 ? 'btn btn-primary jt-go' : 'jt-text'}>
                      {r.next.label}
                      <PendingHint />
                    </Link>
                  ) : (
                    <span className="jt-none">Nothing to do</span>
                  )}
                  {r.extra ? <Link href={r.extra.href} className="jt-text jt-extra">{r.extra.label}<PendingHint /></Link> : null}
                  {r.deleteDoc ? <DeleteDraft documentId={r.deleteDoc.id} label={r.deleteDoc.label} back="home" /> : null}
                </td>
                <td role="cell" className="jt-date is-num">
                  {r.updated ? <time dateTime={r.updated}>{fmt(r.updated)}</time> : <span aria-label="No date">&ndash;</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
