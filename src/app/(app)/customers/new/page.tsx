import type { Metadata } from 'next';
import Link from 'next/link';
import { CustomerForm } from '../../../../components/customers/CustomerForm';
import { PageHeader } from '../../../../components/PageHeader';
import { requireSession } from '../../../../lib/session';
import { createCustomerAction } from '../actions';

export const metadata: Metadata = { title: 'Add a customer', description: 'Add a customer so their details go on every document you make for them.' };

export default async function NewCustomerPage() {
  await requireSession();
  return (
    <div className="page page-mid">
      <PageHeader muted="Add a" title="customer" lede="Fill this in once. Their name and address then go on every document you make for them." />
      <div className="form-panel">
        <CustomerForm action={createCustomerAction} submitLabel="Save customer" />
      </div>
      <p className="cust-back"><Link href="/customers">Back to customers</Link></p>
    </div>
  );
}
