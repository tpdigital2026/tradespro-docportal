import type { Metadata } from 'next';
import Link from 'next/link';
import { ButtonLink } from '../../../components/Button';
import { DeleteDraft } from '../../../components/DeleteDraft';
import { DocTypeIcon } from '../../../components/DocTypeIcon';
import type { DeleteBack } from './delete-actions';
import { EmptyState } from '../../../components/EmptyState';
import { NewDocumentMenu } from '../../../components/NewDocumentMenu';
import { PageHeader } from '../../../components/PageHeader';
import { groupLibrary, LIBRARY_KINDS, LIBRARY_LIMIT, listLibrary, type LibraryItem, type LibraryKind } from '../../../lib/data/documents';
import { DOC_TYPE_NAMES, jobHref } from '../../../lib/job-stage';
import { formatGBP } from '../../../lib/money';
import { requireSession } from '../../../lib/session';

export const metadata: Metadata = { title: 'Documents', description: 'Every quote, invoice and receipt you have made, grouped by job.' };

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function href(f: { kind?: string | null; status?: string | null; q?: string | null }): string {
  const p = new URLSearchParams();
  if (f.kind) p.set('type', f.kind);
  if (f.status) p.set('status', f.status);
  if (f.q) p.set('q', f.q);
  const s = p.toString();
  return s ? `/documents?${s}` : '/documents';
}

function Row({ d, back }: { d: LibraryItem; back: DeleteBack }) {
  const final = d.status === 'final';
  return (
    <li className={`lib-row${final ? '' : ' is-draft'}`}>
      <Link href={`/documents/${d.id}`} className="lib-link">
        <span className="doc-chip" aria-hidden="true"><DocTypeIcon type={d.type} /></span>
        <span className="lib-main">
          <span className="lib-title">{DOC_TYPE_NAMES[d.type]}</span>
          <span className="lib-meta">{d.number}<span aria-hidden="true"> · </span><span className="sr-only">, </span>{dateFmt.format(new Date(d.date))}</span>
        </span>
        <span className="lib-end">
          <span className={`status-chip ${final ? 'is-final' : 'is-draft'}`}>{final ? 'Final' : 'Draft'}</span>
          {d.totalPence !== null && final ? <span className="lib-amount">{formatGBP(d.totalPence)}</span> : null}
        </span>
      </Link>
      {final ? (
        <a className="lib-download" href={`/api/documents/${d.id}/pdf`} download aria-label={`Download ${DOC_TYPE_NAMES[d.type].toLowerCase()} ${d.number}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" /></svg>
          <span>PDF</span>
        </a>
      ) : !d.everIssued ? (
        <DeleteDraft variant="row" documentId={d.id} label={`${DOC_TYPE_NAMES[d.type]} ${d.number}`} back={back} />
      ) : null}
    </li>
  );
}

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const sp = await searchParams;
  const kindRaw = first(sp.type);
  const kind = LIBRARY_KINDS.some((k) => k.key === kindRaw) ? (kindRaw as LibraryKind) : null;
  const statusRaw = first(sp.status);
  const status = statusRaw === 'draft' || statusRaw === 'final' ? statusRaw : null;
  const q = (first(sp.q) ?? '').trim().slice(0, 60);
  const deleted = first(sp.deleted) === 'draft';

  const filtering = kind !== null || status !== null || q !== '';
  let items: LibraryItem[] = [];
  let truncated = false;
  let anyAtAll = true;
  let drafts: LibraryItem[] = [];
  let failed = false;
  try {
    // Filters and search run in the database, so older documents are found however many there are.
    // The list and the drafts strip load side by side; the "anything at all" check only runs for an empty filter.
    const draftsAreList = status === 'draft' && !kind && !q;
    const [page, draftPage] = await Promise.all([listLibrary({ kind, status, q }), draftsAreList ? null : listLibrary({ status: 'draft', limit: 8 })]);
    items = page.items;
    truncated = page.truncated;
    if (items.length === 0 && filtering) anyAtAll = (await listLibrary({ limit: 1 })).items.length > 0;
    else anyAtAll = items.length > 0;
    drafts = draftPage ? draftPage.items : items;
  } catch {
    failed = true;
  }
  const groups = groupLibrary(items);
  const shownCount = items.length;

  return (
    <div className="ws">
      <PageHeader
        title="Documents"
        lede="Every quote, invoice and receipt, grouped by job. Drafts open for editing. Final documents download as a PDF."
        action={<NewDocumentMenu />}
      />

      {deleted ? <p className="flash" role="status">Draft deleted.</p> : null}
      {failed ? (
        <p className="form-error" role="alert">We could not load your documents just now. Please try again.</p>
      ) : !anyAtAll ? (
        <EmptyState icon="docs" title="No documents yet" action={<ButtonLink href="/documents/new?type=quotation">Start a quotation</ButtonLink>}>
          Everything you make lands here: quotes first, then the invoices and receipts that follow them.
        </EmptyState>
      ) : (
        <>
          <section aria-label="Find a document" className="lib-tools">
            <form method="get" action="/documents" className="lib-search" role="search">
              {kind ? <input type="hidden" name="type" value={kind} /> : null}
              {status ? <input type="hidden" name="status" value={status} /> : null}
              <div className="field search-field">
                <label htmlFor="doc-search">Search</label>
                <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.5 15.5L20 20" /></svg>
                <input id="doc-search" name="q" className="input search-input" type="search" defaultValue={q} placeholder="Quote number or customer" autoComplete="off" spellCheck={false} maxLength={60} />
              </div>
              <button type="submit" className="btn btn-secondary">Search</button>
            </form>
            <nav aria-label="Filter by type" className="lib-filters">
              <ul>
                <li><Link href={href({ status, q })} className="filter-chip" aria-current={kind === null ? 'true' : undefined}>All types</Link></li>
                {LIBRARY_KINDS.map((k) => (
                  <li key={k.key}><Link href={href({ kind: k.key, status, q })} className="filter-chip" aria-current={kind === k.key ? 'true' : undefined}>{k.label}</Link></li>
                ))}
              </ul>
            </nav>
            <nav aria-label="Filter by status" className="lib-filters">
              <ul>
                <li><Link href={href({ kind, q })} className="filter-chip" aria-current={status === null ? 'true' : undefined}>Draft and final</Link></li>
                <li><Link href={href({ kind, status: 'draft', q })} className="filter-chip" aria-current={status === 'draft' ? 'true' : undefined}>Drafts</Link></li>
                <li><Link href={href({ kind, status: 'final', q })} className="filter-chip" aria-current={status === 'final' ? 'true' : undefined}>Final</Link></li>
              </ul>
            </nav>
            {truncated ? <p className="lib-cap" role="note">Showing your newest {LIBRARY_LIMIT} documents. Use search or filters.</p> : null}
            <p className="cust-count" role="status">
              {filtering ? `${shownCount} matching ${shownCount === 1 ? 'document' : 'documents'}` : `${shownCount} ${shownCount === 1 ? 'document' : 'documents'} in ${groups.length} ${groups.length === 1 ? 'job' : 'jobs'}`}
              {filtering ? (
                <>
                  {' '}
                  <Link href="/documents" className="lib-clear">Clear</Link>
                </>
              ) : null}
            </p>
          </section>

          <div className="lib-layout">
          <div className="lib-col">
          {groups.length === 0 ? (
            <EmptyState icon="search" title="Nothing matches">
              Try another quote number or name, or clear the filters to see everything.
            </EmptyState>
          ) : (
            <div className="lib-groups">
              {groups.map((g) => {
                const issued = g.items.some((i) => i.type === 'quotation' && i.status === 'final');
                return (
                  <section key={g.jobId} className="lib-group" aria-labelledby={`job-${g.jobId}`}>
                    <header className="lib-group-head">
                      <h2 id={`job-${g.jobId}`} className="lib-group-title">
                        <span className="lib-group-q">Quote {g.quoteNumber}</span>
                        <span className="lib-group-c">{g.customerName}</span>
                      </h2>
                      {issued ? <Link href={jobHref(g.quoteNumber)} className="lib-job-link">Open the job</Link> : null}
                    </header>
                    <ul className="lib-list">
                      {g.items.map((d) => (
                        <Row key={d.id} d={d} back={status === 'draft' ? 'drafts' : 'documents'} />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
          </div>
          {drafts.length ? (
            <aside className="lib-side" aria-labelledby="todo-h">
              <h2 id="todo-h" className="section-title">Waiting to be finalised</h2>
              <p className="section-sub">A draft cannot be downloaded. Open it, read every page and tick to make it final.</p>
              <ul className="mini-list">
                {drafts.slice(0, 8).map((d) => (
                  <li key={d.id}>
                    <Link href={`/documents/${d.id}`} className="mini-row">
                      <span className="doc-chip" aria-hidden="true"><DocTypeIcon type={d.type} /></span>
                      <span className="mini-main">
                        <span className="mini-title">{DOC_TYPE_NAMES[d.type]}</span>
                        <span className="mini-meta">{d.number} for {d.customerName}</span>
                      </span>
                      <span className="mini-go">Open</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </aside>
          ) : null}
          </div>
        </>
      )}
    </div>
  );
}
