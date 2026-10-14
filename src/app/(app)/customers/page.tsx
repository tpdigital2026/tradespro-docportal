import { ButtonLink } from '../../../components/Button';
import { CustomerSearch, type CustomerListItem } from '../../../components/customers/CustomerSearch';
import { PageHeader } from '../../../components/PageHeader';
import { listCustomers } from '../../../lib/data/customers';
import { daysLeft, formatKeptUntilShort, isRunningOut } from '../../../lib/retention';
import { requireSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';

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
    <div className="page">
      <PageHeader muted="Your" title="customers" action={<ButtonLink href="/customers/new" className="btn-block-sm">Add a customer</ButtonLink>} />
      {deleted ? <p className="cust-flash" role="status">That customer and their files have been deleted.</p> : null}
      <CustomerSearch customers={items} />
    </div>
  );
}
