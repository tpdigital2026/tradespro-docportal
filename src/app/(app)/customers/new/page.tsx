import Link from 'next/link';
import { CustomerForm } from '../../../../components/customers/CustomerForm';
import { PageHeader } from '../../../../components/PageHeader';
import { requireSession } from '../../../../lib/session';
import { createCustomerAction } from '../actions';

export default async function NewCustomerPage() {
  await requireSession();
  return (
    <div className="page">
      <PageHeader muted="Add a" title="customer" lede="Their details go on the paperwork you make for them." />
      <CustomerForm action={createCustomerAction} submitLabel="Save customer" />
      <p className="cust-back"><Link href="/customers">Back to customers</Link></p>
    </div>
  );
}
