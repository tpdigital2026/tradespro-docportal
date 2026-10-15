import type { Metadata } from 'next';
import Link from 'next/link';
import { ButtonLink } from '../../../components/Button';
import { EmptyState } from '../../../components/EmptyState';
import { PageHeader } from '../../../components/PageHeader';
import { BALANCE_FILTERS, methodLabel, type InvoiceLine, type JobBalance } from '../../../lib/business/money-board';
import { exportHref, moneyHref, moneyView, parseMoneyParams, type MoneyView } from '../../../lib/business/money-view';
import { getBusinessFacts, type BusinessFacts } from '../../../lib/data/business';
import { isDemo } from '../../../lib/demo';
import { DOC_TYPE_NAMES, jobHref, newDocumentHref } from '../../../lib/job-stage';
import { monthLabel, shortDate, todayLondon } from '../../../lib/london';
import { formatGBP } from '../../../lib/money';
import { requireSession } from '../../../lib/session';
import '../../../styles/business.css';

export const metadata: Metadata = { title: 'Money', description: 'Balances owed on your invoices and the payments you have recorded.' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function InvoiceStatus({ i }: { i: InvoiceLine }) {
  if (i.settled) return <span className="status-chip is-paid">Settled</span>;
  if (i.overdue) return <span className="status-chip mn-overdue">Overdue by {plural(i.daysOverdue, 'day')}</span>;
  if (i.receivedPence > 0) return <span className="status-chip is-part">Part paid</span>;
  return <span className="status-chip is-draft">Not paid yet</span>;
}

function due(i: InvoiceLine, today: string): string {
  if (i.settled) return '';
  if (i.dueOn) return i.dueOn === today ? 'Due today' : i.dueOn < today ? `Was due ${shortDate(i.dueOn)}` : `Due ${shortDate(i.dueOn)}`;
  return i.dueWording ? `Due: ${i.dueWording.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}` : 'No due date on the invoice';
}

function JobPanel({ b, today, linkable }: { b: JobBalance; today: string; linkable: boolean }) {
  return (
    <li className={`mn-job${b.overdue ? ' is-overdue' : ''}${b.settled ? ' is-settled' : ''}`}>
      <div className="mn-job-head">
        <h3 className="mn-job-name">
          {linkable ? <Link href={jobHref(b.quoteNumber)} className="pl-name-link">{b.customerName}</Link> : b.customerName}
          <span className="mn-job-ref">Quote {b.quoteNumber}</span>
        </h3>
        <p className="mn-owed">
          {b.settled ? (
            <span className="status-chip is-paid">Settled</span>
          ) : b.outstandingPence === 0 ? (
            <>
              <span className="mn-owed-label">Outstanding</span>
              <span className="mn-owed-zero">Nothing owed on invoices</span>
            </>
          ) : (
            <>
              <span className="mn-owed-label">Outstanding</span>
              <span className={`mn-owed-n${b.overdue ? ' is-overdue' : ''}`}>{formatGBP(b.outstandingPence)}</span>
            </>
          )}
        </p>
      </div>
      <dl className="mn-figs">
        <div><dt>Quoted</dt><dd>{formatGBP(b.quotedPence)}</dd></div>
        <div><dt>Invoiced so far</dt><dd>{formatGBP(b.invoicedPence)}</dd></div>
        <div><dt>Received</dt><dd>{formatGBP(b.receivedPence)}</dd></div>
        <div><dt>Still to invoice</dt><dd>{formatGBP(b.toInvoicePence)}</dd></div>
      </dl>
      {b.invoices.length ? (
        <ul className="mn-lines" aria-label={`Invoices for quote ${b.quoteNumber}`}>
          {b.invoices.map((i) => (
            <li key={i.documentId} className={`mn-line${i.overdue ? ' is-overdue' : ''}`}>
              <div className="mn-line-main">
                <p className="mn-line-title">
                  {linkable ? <Link href={`/documents/${i.documentId}`} className="mn-doc-link">{i.number}</Link> : <span>{i.number}</span>}
                  <span className="mn-line-part">{DOC_TYPE_NAMES[i.type]}{i.type === 'invoice-stage' ? `, ${i.part.toLowerCase()}` : ''}</span>
                </p>
                <p className="mn-line-meta">Issued {shortDate(i.issuedOn)}{due(i, today) ? <><span aria-hidden="true"> · </span><span className="sr-only">. </span>{due(i, today)}</> : null}</p>
              </div>
              <div className="mn-line-money">
                <p className="mn-line-amt">{formatGBP(i.grossPence)}</p>
                <p className="mn-line-rcv">{i.receivedPence > 0 && !i.settled ? `${formatGBP(i.receivedPence)} received` : i.settled ? 'Paid in full' : 'Nothing received'}</p>
              </div>
              <div className="mn-line-status"><InvoiceStatus i={i} /></div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mn-none">No invoice raised yet.</p>
      )}
    </li>
  );
}

function Balances({ v, today, noPage }: { v: MoneyView; today: string; noPage: ReadonlySet<string> }) {
  const b = v.balances;
  const label = BALANCE_FILTERS.find((f) => f.key === v.params.filter)?.label ?? 'All jobs';
  return (
    <section aria-labelledby="bal-h" className="mn-sec">
      <div className="mn-sec-head">
        <h2 id="bal-h" className="section-title">Balances owed</h2>
        <p className="section-sub">Per job: what you quoted, what you have invoiced and what has come in. Overdue first.</p>
      </div>
      <nav aria-label="Filter balances" className="lib-filters">
        <ul>
          {BALANCE_FILTERS.map((f) => (
            <li key={f.key}>
              <Link href={moneyHref({ view: 'balances', filter: f.key })} className="filter-chip" aria-current={v.params.filter === f.key ? 'true' : undefined}>
                {f.label} <span className="pl-n">{b.counts[f.key]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mn-tools">
        <p className="cust-count" role="status">{plural(b.rows.length, 'job')}{v.params.filter === 'all' ? '' : `: ${label.toLowerCase()}`}</p>
        {b.rows.length ? <a className="btn btn-secondary mn-export" href={exportHref(v.params)} download title="Opens in Excel, Numbers or Google Sheets">Download as CSV</a> : null}
      </div>
      {b.rows.length ? (
        <ul className="mn-jobs">
          {b.rows.map((row) => <JobPanel key={row.jobId} b={row} today={today} linkable={!noPage.has(row.jobId)} />)}
        </ul>
      ) : (
        <EmptyState icon="search" title={`No jobs ${label.toLowerCase() === 'settled' ? 'settled yet' : `${label.toLowerCase()} right now`}`} compact>
          {v.params.filter === 'overdue' ? 'Nothing is past its due date. Due dates come from the wording printed on each invoice.' : 'Pick another filter to see the rest.'}
        </EmptyState>
      )}
    </section>
  );
}

function Payments({ v, noPage }: { v: MoneyView; noPage: ReadonlySet<string> }) {
  const rows = v.monthPayments;
  return (
    <section aria-labelledby="pay-h" className="mn-sec">
      <div className="mn-sec-head">
        <h2 id="pay-h" className="section-title">Payments received</h2>
        <p className="section-sub">Every payment you marked as paid, newest first.</p>
      </div>
      <nav aria-label="Choose the month" className="mn-month">
        <Link href={moneyHref({ view: 'payments', month: v.prevMonth })} className="btn btn-secondary mn-month-btn" aria-label={`Previous month, ${monthLabel(v.prevMonth)}`}>
          <span aria-hidden="true">&lsaquo;</span>
        </Link>
        <p className="mn-month-label" aria-live="polite">{monthLabel(v.params.month)}</p>
        {v.nextMonth ? (
          <Link href={moneyHref({ view: 'payments', month: v.nextMonth })} className="btn btn-secondary mn-month-btn" aria-label={`Next month, ${monthLabel(v.nextMonth)}`}>
            <span aria-hidden="true">&rsaquo;</span>
          </Link>
        ) : (
          <span className="mn-month-btn is-off" aria-hidden="true" />
        )}
      </nav>
      {/* This month's totals are already in the summary above. */}
      {v.nextMonth === null ? null : <dl className="mn-run">
        <div><dt>Received in {monthLabel(v.params.month)}</dt><dd>{formatGBP(v.totals.monthPence)}<span>{plural(v.totals.monthCount, 'payment')}</span></dd></div>
        <div><dt>Received in {v.params.month.slice(0, 4)}</dt><dd>{formatGBP(v.totals.yearPence)}<span>{plural(v.totals.yearCount, 'payment')}</span></dd></div>
      </dl>}
      <div className="mn-tools">
        {rows.length ? <p className="cust-count" role="status">{plural(rows.length, 'payment')} in {monthLabel(v.params.month)}</p> : null}
        {rows.length ? <a className="btn btn-secondary mn-export" href={exportHref(v.params)} download title="Opens in Excel, Numbers or Google Sheets">Download as CSV</a> : null}
      </div>
      {rows.length ? (
        <div className="mn-table-wrap">
          <table className="mn-table">
            <caption className="sr-only">Payments received in {monthLabel(v.params.month)}</caption>
            <thead>
              <tr><th scope="col">Date</th><th scope="col">Customer</th><th scope="col">For</th><th scope="col" className="is-num">Amount</th><th scope="col">Method</th><th scope="col">Receipt</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const linkable = !noPage.has(r.jobId);
                return (
                  <tr key={r.id}>
                    <td data-label="Date" className="mn-td-date">{shortDate(r.paidOn)}</td>
                    <td data-label="Customer"><span className="mn-cust">{r.customerName}</span><span className="mn-sub">Quote {r.quoteNumber}</span></td>
                    <td data-label="For">{r.part}<span className="mn-sub">{r.invoiceNumber}</span></td>
                    <td data-label="Amount" className="is-num mn-amt">{formatGBP(r.amountPence)}</td>
                    <td data-label="Method">{methodLabel(r.method)}</td>
                    <td data-label="Receipt">
                      {r.receiptDocumentId && r.receiptNumber ? (
                        linkable ? <Link href={`/documents/${r.receiptDocumentId}`} className="mn-doc-link">{r.receiptNumber}{r.receiptFinal ? '' : ' (draft)'}</Link> : <span>{r.receiptNumber}</span>
                      ) : linkable && r.instalment ? (
                        <Link href={newDocumentHref('receipt', r.quoteNumber, { n: r.instalment, payment: r.id })} className="mn-doc-link">Create receipt</Link>
                      ) : (
                        <span className="mn-sub">No receipt yet</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon="docs" title={`No payments recorded in ${monthLabel(v.params.month)}`} compact>
          When a customer pays, open the job and use Mark as paid. The payment is listed here straight away.
        </EmptyState>
      )}
    </section>
  );
}

export default async function MoneyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const sp = await searchParams;
  const today = todayLondon();
  const params = parseMoneyParams(sp, today);
  let facts: BusinessFacts | null = null;
  try {
    facts = await getBusinessFacts();
  } catch {
    facts = null;
  }
  const v = facts ? moneyView(facts.jobs, params, today) : null;
  const anything = v ? v.balances.anyInvoices || v.allPayments.length > 0 : false;

  return (
    <div className="page page-wide">
      <PageHeader muted="Your" title="money" lede="What you are owed on the invoices you have issued, and the payments you have marked as paid." />
      {isDemo() ? <p className="demo-chip">Demo mode. Everything here is dummy data.</p> : null}

      {!v ? (
        <p className="form-error" role="alert">We could not load your figures just now. Please try again.</p>
      ) : !anything ? (
        <EmptyState icon="docs" title="Nothing to show yet" action={<ButtonLink href="/documents">Go to your documents</ButtonLink>}>
          Balances appear here once you issue an invoice, and payments once you mark one as paid. Every figure comes from your own documents, never an estimate.
        </EmptyState>
      ) : (
        <>
          <p className="mn-note" role="note">
            <strong>Recorded by you, not checked against your bank.</strong> These figures add up your issued invoices and the payments you marked as paid.
          </p>
          <dl className="mn-summary">
            <div className="is-lead">
              <dt>Outstanding on invoices</dt>
              <dd>{formatGBP(v.balances.outstandingPence)}</dd>
            </div>
            <div className={v.balances.overdueInvoices ? 'is-overdue' : undefined}>
              <dt>Overdue</dt>
              <dd>{v.balances.overdueInvoices ? `${plural(v.balances.overdueInvoices, 'invoice')}` : 'None'}{v.balances.overdueInvoices ? <span>{formatGBP(v.balances.overduePence)}</span> : null}</dd>
            </div>
            <div>
              <dt>Received in {monthLabel(today.slice(0, 7))}</dt>
              <dd>{formatGBP(v.current.monthPence)}</dd>
            </div>
            <div>
              <dt>Received in {today.slice(0, 4)}</dt>
              <dd>{formatGBP(v.current.yearPence)}</dd>
            </div>
          </dl>

          <nav aria-label="Money views" className="mn-tabs">
            <ul>
              <li><Link href={moneyHref({ view: 'balances', filter: params.filter })} aria-current={params.view === 'balances' ? 'page' : undefined} className="mn-tab">Balances owed</Link></li>
              <li><Link href={moneyHref({ view: 'payments', month: params.month })} aria-current={params.view === 'payments' ? 'page' : undefined} className="mn-tab">Payments received</Link></li>
            </ul>
          </nav>

          {params.view === 'balances' ? <Balances v={v} today={today} noPage={facts!.noJobPage} /> : <Payments v={v} noPage={facts!.noJobPage} />}
        </>
      )}
    </div>
  );
}
