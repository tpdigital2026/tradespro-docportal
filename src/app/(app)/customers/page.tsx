import type { Metadata } from 'next';
import { ButtonLink } from '../../../components/Button';
import { CustomerSearch, type CustomerListItem } from '../../../components/customers/CustomerSearch';
import { PageHeader } from '../../../components/PageHeader';
import { listCustomers } from '../../../lib/data/customers';
import { daysLeft, formatKeptUntilShort, isRunningOut } from '../../../lib/retention';
import { requireSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Customers', description: 'Find, add and update the customers you make documents for.' };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  await requireSession();
  const { deleted } = await searchParams;
  const now = new Date();
  const customers = await listCustomers();
  const items: CustomerListItem[] = customers.map((c) => {
    const left = daysLeft(c.purgeAt, now);
    return {
      id: c.id,
      name: c.name,
      address: c.addressLines.join(', '),
      postcode: c.postcode,
      keptUntil: formatKeptUntilShort(c.purgeAt),
      daysLeft: left,
      runningOut: isRunningOut(left),
    };
  });
  return (
    <div className="ws page-mid">
      <PageHeader
        title="Customers"
        lede="Everyone you make documents for. Open a name to see their documents or change their details."
        action={items.length > 0 ? <ButtonLink href="/customers/new">Add a customer</ButtonLink> : undefined}
      />
      {deleted ? <p className="flash" role="status">That customer and their files have been deleted.</p> : null}
      <CustomerSearch customers={items} />
    </div>
  );
}
