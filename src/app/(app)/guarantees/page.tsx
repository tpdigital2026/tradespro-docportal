import type { Metadata } from 'next';
import Link from 'next/link';
import { ButtonLink } from '../../../components/Button';
import { EmptyState } from '../../../components/EmptyState';
import { PageHeader } from '../../../components/PageHeader';
import { filterGuarantees, guaranteeRows, isGuaranteeFilter, type GuaranteeFilter, type GuaranteeRow } from '../../../lib/business/guarantees';
import { getBusinessFacts, type BusinessFacts } from '../../../lib/data/business';
import { isDemo } from '../../../lib/demo';
import { shortDate, todayLondon } from '../../../lib/london';
import { requireSession } from '../../../lib/session';
import '../../../styles/business.css';

export const metadata: Metadata = { title: 'Guarantees', description: 'Every guarantee certificate you have issued, with when each one runs out.' };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function href(f: { filter?: GuaranteeFilter; q?: string }): string {
  const p = new URLSearchParams();
  if (f.filter && f.filter !== 'all') p.set('show', f.filter);
  if (f.q) p.set('q', f.q);
  const s = p.toString();
  return s ? `/guarantees?${s}` : '/guarantees';
}

function Row({ r, year, linkable }: { r: GuaranteeRow; year: number; linkable: boolean }) {
  const ending = r.expiryYear !== null && r.expiryYear === year;
  const ended = r.expiryYear !== null && r.expiryYear < year;
  return (
    <li className={`gu-row${ending ? ' is-ending' : ''}`}>
      <div className="gu-main">
        <p className="gu-name">{r.customerName}</p>
        <p className="gu-meta">{r.addressLine ? `${r.addressLine}. ` : ''}Quote {r.quoteNumber}</p>
      </div>
      <dl className="gu-facts">
        <div><dt>Issued</dt><dd>{shortDate(r.issuedOn)}</dd></div>
        <div><dt>Length</dt><dd>{r.years === null ? 'Not recorded' : `${r.years} ${r.years === 1 ? 'year' : 'years'}`}</dd></div>
        <div>
          <dt>Runs until</dt>
          <dd>
            {r.expiryYear === null ? 'Not recorded' : r.expiryYear}
            {ending ? <span className="status-chip is-part gu-chip">Ends this year</span> : ended ? <span className="status-chip is-draft gu-chip">Ended</span> : null}
          </dd>
        </div>
      </dl>
      <div className="gu-doc">
        {linkable ? (
          <Link href={`/documents/${r.documentId}`} className="mn-doc-link gu-link">Certificate {r.certificateNo}</Link>
        ) : (
          <span className="gu-cert">Certificate {r.certificateNo}</span>
        )}
      </div>
    </li>
  );
}

export default async function GuaranteesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const sp = await searchParams;
  const showRaw = first(sp.show);
  const filter: GuaranteeFilter = isGuaranteeFilter(showRaw) ? showRaw : 'all';
  const q = (first(sp.q) ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
  const year = Number(todayLondon().slice(0, 4));
  let facts: BusinessFacts | null = null;
  try {
    facts = await getBusinessFacts();
  } catch {
    facts = null;
  }
  const all = facts ? guaranteeRows(facts.jobs) : [];
  const shown = filterGuarantees(all, { filter, q, year });
  const endingCount = all.filter((r) => r.expiryYear === year).length;

  return (
    <div className="page page-mid">
      <PageHeader muted="Your" title="guarantees" lede="Every guarantee certificate you have issued, newest first, with the year each one runs out." action={<ButtonLink href="/documents/new?type=guarantee">Issue a guarantee</ButtonLink>} />
      {isDemo() ? <p className="demo-chip">Demo mode. Everything here is dummy data.</p> : null}

      {!facts ? (
        <p className="form-error" role="alert">We could not load your guarantees just now. Please try again.</p>
      ) : all.length === 0 ? (
        <EmptyState icon="docs" title="No guarantees issued yet" action={<ButtonLink href="/documents/new?type=guarantee">Issue a guarantee</ButtonLink>}>
          When you issue a guarantee certificate for a finished job, it is listed here with its customer, how long it lasts and the year it runs out.
        </EmptyState>
      ) : (
        <>
          <section aria-label="Find a guarantee" className="lib-tools">
            <form method="get" action="/guarantees" className="lib-search" role="search">
              {filter !== 'all' ? <input type="hidden" name="show" value={filter} /> : null}
              <div className="field search-field">
                <label htmlFor="gu-search">Search</label>
                <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.5 15.5L20 20" /></svg>
                <input id="gu-search" name="q" className="input search-input" type="search" defaultValue={q} placeholder="Customer, address or number" autoComplete="off" spellCheck={false} maxLength={60} />
              </div>
              <button type="submit" className="btn btn-secondary">Search</button>
            </form>
            <nav aria-label="Filter guarantees" className="lib-filters">
              <ul>
                <li><Link href={href({ q })} className="filter-chip" aria-current={filter === 'all' ? 'true' : undefined}>All <span className="pl-n">{all.length}</span></Link></li>
                <li><Link href={href({ filter: 'this-year', q })} className="filter-chip" aria-current={filter === 'this-year' ? 'true' : undefined}>Ending in {year} <span className="pl-n">{endingCount}</span></Link></li>
              </ul>
            </nav>
            <p className="cust-count" role="status">
              {shown.length} {shown.length === 1 ? 'certificate' : 'certificates'}
              {q || filter !== 'all' ? (
                <>
                  {' '}
                  <Link href="/guarantees" className="lib-clear">Clear</Link>
                </>
              ) : null}
            </p>
          </section>
          {shown.length ? (
            <ul className="gu-list">
              {shown.map((r) => <Row key={r.documentId} r={r} year={year} linkable={!facts!.noJobPage.has(facts!.jobs.find((j) => j.quoteNumber === r.quoteNumber)?.jobId ?? '')} />)}
            </ul>
          ) : (
            <EmptyState icon="search" title={filter === 'this-year' && !q ? `None end in ${year}` : 'Nothing matches'} compact>
              {filter === 'this-year' && !q ? 'No certificate you have issued runs out this year.' : 'Try another name or number, or clear the search.'}
            </EmptyState>
          )}
        </>
      )}
    </div>
  );
}
