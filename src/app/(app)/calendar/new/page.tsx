import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '../../../../components/PageHeader';
import { getLinkOptions, type LinkOptions } from '../../../../lib/data/appointments';
import { isDemo } from '../../../../lib/demo';
import { isIsoDate, todayLondon } from '../../../../lib/london';
import { requireSession } from '../../../../lib/session';
import { saveAppointmentAction } from '../actions';
import { AppointmentForm } from '../AppointmentForm';
import '../../../../styles/business.css';

export const metadata: Metadata = { title: 'Add appointment', description: 'Book a site visit, survey or job date into your calendar.' };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NewAppointmentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const sp = await searchParams;
  const d = first(sp.d);
  const date = isIsoDate(d) ? d : todayLondon();
  let links: LinkOptions = { customers: [], jobs: [] };
  let failed = false;
  try {
    links = await getLinkOptions();
  } catch {
    failed = true;
  }
  return (
    <div className="page">
      <PageHeader muted="Add an" title="appointment" lede="It goes on your calendar here. You can then add it to the calendar on your phone." compact />
      {isDemo() ? <p className="demo-chip">Demo mode. Everything here is dummy data.</p> : null}
      {failed ? <p className="form-error" role="alert">We could not load your customers just now, so you can only save it without one.</p> : null}
      <div className="form-panel">
        <AppointmentForm
          action={saveAppointmentAction.bind(null, null)}
          initial={{ kind: 'site_visit', title: '', date, start: '09:00', endDate: '', end: '', customerId: '', jobId: '', notes: '' }}
          links={links}
          submitLabel="Save appointment"
        />
      </div>
      <p className="cust-back"><Link href="/calendar">Back to the calendar</Link></p>
    </div>
  );
}
