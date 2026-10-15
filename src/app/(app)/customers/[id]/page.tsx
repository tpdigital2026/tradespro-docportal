import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CustomerForm } from '../../../../components/customers/CustomerForm';
import { DeleteCustomer } from '../../../../components/customers/DeleteCustomer';
import { KeepForm } from '../../../../components/customers/KeepForm';
import { SavedNotice } from '../../../../components/customers/SavedNotice';
import { PageHeader } from '../../../../components/PageHeader';
import { savedKindFrom } from '../../../../lib/customer-flash';
import { getCustomer, getRetentionDays, listCustomerDocuments } from '../../../../lib/data/customers';
import { daysLeft, formatKeptUntil, isRunningOut } from '../../../../lib/retention';
import { requireSession } from '../../../../lib/session';
import type { CustomerFormValues } from '../../../../lib/validation/customer';
import { updateCustomerAction } from '../actions';

export const dynamic = 'force-dynamic';

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
    <div className="page">
      <PageHeader muted="Customer" title={customer.name} />
      {saved === 'created' ? <SavedNotice key={stamp} kind={saved} bringIntoView={false} /> : null}
      {flags.kept ? <p className="cust-flash" role="status">Done. This customer's details are kept for longer.</p> : null}

      <section className={`cust-retention${warn ? ' is-warn' : ''}`} aria-label="How long their details are kept">
        <p className="cust-retention-main">Data kept until {formatKeptUntil(customer.purgeAt)}</p>
        <p className="row-meta">Any new document resets this.</p>
        {warn ? (
          <div className="cust-retention-warn">
            <p role="status">
              {left === 0 ? 'This customer is due to be deleted today.' : `Only ${left} ${left === 1 ? 'day' : 'days'} left before this customer and their files are deleted.`}
            </p>
            <KeepForm customerId={customer.id} days={retentionDays} />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="docs-h" className="cust-section">
        <h2 id="docs-h" className="section-title">Documents</h2>
        {docs.length ? (
          <ul className="rows">
            {docs.map((d) => (
              <li key={d.id} className="row">
                <div className="row-main">
                  <p className="row-title">{TYPE_NAMES[d.type] ?? 'Document'}</p>
                  <p className="row-meta">{d.number} · {dateFmt.format(new Date(d.date))}</p>
                </div>
                <p className="row-tag">{d.status === 'draft' ? 'Draft' : 'Final'}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No documents for this customer yet.</p>
        )}
      </section>

      <section aria-labelledby="edit-h" className="cust-section">
        <h2 id="edit-h" className="section-title">Their details</h2>
        {saved === 'updated' ? <SavedNotice key={stamp} kind={saved} /> : null}
        <CustomerForm action={updateCustomerAction.bind(null, customer.id)} initial={initial} submitLabel="Save changes" />
      </section>

      {session.role === 'owner' ? (
        <DeleteCustomer customerId={customer.id} customerName={customer.name} ownerEmail={session.email} />
      ) : null}
      <p className="cust-back"><Link href="/customers">Back to customers</Link></p>
    </div>
  );
}
