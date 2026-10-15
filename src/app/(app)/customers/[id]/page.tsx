import type { Metadata } from 'next';
import Link from 'next/link';
import { ButtonLink } from '../../../../components/Button';
import { notFound } from 'next/navigation';
import { CustomerForm } from '../../../../components/customers/CustomerForm';
import { DeleteCustomer } from '../../../../components/customers/DeleteCustomer';
import { KeepForm } from '../../../../components/customers/KeepForm';
import { SavedNotice } from '../../../../components/customers/SavedNotice';
import { EmptyState } from '../../../../components/EmptyState';
import { PageHeader } from '../../../../components/PageHeader';
import { initials } from '../../../../lib/initials';
import { savedKindFrom } from '../../../../lib/customer-flash';
import { getCustomer, getRetentionDays, listCustomerDocuments } from '../../../../lib/data/customers';
import { daysLeft, formatKeptUntil, isRunningOut } from '../../../../lib/retention';
import { isDemo } from '../../../../lib/demo';
import { requireSession } from '../../../../lib/session';
import type { CustomerFormValues } from '../../../../lib/validation/customer';
import { updateCustomerAction } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Customer details', description: 'A customer, their documents and how long their details are kept.' };

const TYPE_NAMES: Record<string, string> = {
  quotation: 'Quotation',
  deposit_invoice: 'Deposit invoice',
  balance_invoice: 'Balance invoice',
  receipt: 'Receipt',
  guarantee: 'Guarantee certificate',
  survey_report: 'Survey report',
};
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string | string[]; kept?: string }>;
}) {
  const session = await requireSession();
  const [{ id }, flags] = await Promise.all([params, searchParams]);
  const customer = await getCustomer(id);
  if (!customer) notFound();
  const [docs, retentionDays] = await Promise.all([listCustomerDocuments(id), getRetentionDays()]);
  const saved = savedKindFrom(flags.saved);
  const stamp = Date.now(); // a new notice for every save, even two in a row
  const left = daysLeft(customer.purgeAt, new Date());
  const warn = isRunningOut(left);
  const initial: CustomerFormValues = {
    name: customer.name,
    address1: customer.addressLines[0] ?? '',
    address2: customer.addressLines[1] ?? '',
    town: customer.addressLines[2] ?? '',
    postcode: customer.postcode,
    email: customer.email ?? '',
    phone: customer.phone ?? '',
  };

  return (
    <div className="page page-wide">
      <PageHeader
        eyebrow="Customer"
        title={customer.name}
        lede={[...customer.addressLines.filter(Boolean), customer.postcode].filter(Boolean).join(', ') || undefined}
        lead={<span className="avatar avatar-lg" aria-hidden="true">{initials(customer.name)}</span>}
      />
      <SavedNotice kind={saved === 'created' ? 'created' : null} stamp={stamp} bringIntoView={false} />
      {flags.kept ? <p className="flash" role="status">Done. This customer&rsquo;s details are kept for longer.</p> : null}

      <div className="cust-layout">
      <div className="cust-side">
      <section className={`cust-retention${warn ? ' is-warn' : ''}`} aria-label="How long their details are kept">
        <p className="cust-retention-main">Details kept until {formatKeptUntil(customer.purgeAt)}</p>
        <p className="row-meta">Making a new document for them resets this.</p>
        {warn ? (
          <div className="cust-retention-warn">
            <p role="status">
              {left === 0 ? 'This customer is due to be deleted today.' : `Only ${left} ${left === 1 ? 'day' : 'days'} left before this customer and their files are deleted.`}
            </p>
            <KeepForm customerId={customer.id} days={retentionDays} />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="docs-h" className="side-panel">
        <div className="sec-head">
          <h2 id="docs-h" className="section-title">Documents</h2>
          <p className="section-sub">{docs.length ? 'Everything made for this customer.' : 'Nothing made for them yet.'}</p>
        </div>
        {docs.length ? (
          <ul className="mini-list">
            {docs.map((d) => (
              <li key={d.id} className="mini-row is-static">
                <span className="mini-main">
                  <span className="mini-title">{TYPE_NAMES[d.type] ?? 'Document'}</span>
                  <span className="mini-meta">{d.number}, {dateFmt.format(new Date(d.date))}</span>
                </span>
                <span className={`status-chip ${d.status === 'draft' ? 'is-draft' : 'is-final'}`}>{d.status === 'draft' ? 'Draft' : 'Final'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="docs" title="No documents yet" compact action={<ButtonLink href={`/documents/new?type=quotation&customer=${customer.id}`} variant="secondary">Start a quotation</ButtonLink>}>
            Quotes, invoices and receipts you make for {customer.name} are listed here.
          </EmptyState>
        )}
      </section>
      </div>

      <section aria-labelledby="edit-h" className="cust-main-col">
        <div className="sec-head">
          <h2 id="edit-h" className="section-title">Their details</h2>
          <p className="section-sub">What goes on their documents. Change anything, then save.</p>
        </div>
        <SavedNotice kind={saved === 'updated' ? 'updated' : null} stamp={stamp} />
        <div className="form-panel">
          <CustomerForm action={updateCustomerAction.bind(null, customer.id)} initial={initial} submitLabel="Save changes" />
        </div>
      </section>
      </div>

      {session.role === 'owner' ? (
        <DeleteCustomer customerId={customer.id} customerName={customer.name} ownerEmail={session.email} demo={isDemo()} />
      ) : null}
      <p className="cust-back"><Link href="/customers">Back to customers</Link></p>
    </div>
  );
}
