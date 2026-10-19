import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '../../../../components/PageHeader';
import { formValuesOf, kindLabel, timeRange } from '../../../../lib/calendar/model';
import { getAppointment, getLinkOptions, isAppointmentId, type LinkOptions } from '../../../../lib/data/appointments';
import { isDemo } from '../../../../lib/demo';
import { jobHref } from '../../../../lib/job-stage';
import { dayLabel, londonDate } from '../../../../lib/london';
import { requireSession } from '../../../../lib/session';
import { saveAppointmentAction } from '../actions';
import { AppointmentForm } from '../AppointmentForm';
import { DeleteAppointment } from '../DeleteAppointment';
import '../../../../styles/business.css';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const a = isAppointmentId(id) ? await getAppointment(id).catch(() => null) : null;
  return { title: a ? kindLabel(a.kind) : 'Appointment', description: 'Change, delete or add this appointment to your phone calendar.' };
}

export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const a = isAppointmentId(id) ? await getAppointment(id) : null;
  if (!a) notFound();
  let links: LinkOptions = { customers: [], jobs: [] };
  try {
    links = await getLinkOptions();
  } catch {
    links = { customers: a.customerId ? [{ id: a.customerId, name: a.customerName ?? 'Customer' }] : [], jobs: [] };
  }
  const day = londonDate(a.startsAt);
  return (
    <div className="page page-mid">
      <PageHeader eyebrow={kindLabel(a.kind)} title={a.title} lede={`${dayLabel(day, true)}, ${timeRange(a)}`} compact />
      {isDemo() ? <p className="demo-chip">Demo mode. Everything here is dummy data.</p> : null}
      <div className="cal-detail">
        <div className="form-panel">
          <h2 className="section-title cal-edit-h">Change it</h2>
          <AppointmentForm action={saveAppointmentAction.bind(null, a.id)} initial={formValuesOf(a)} links={links} submitLabel="Save changes" />
        </div>
        <aside className="cal-side">
          <div className="doc-download">
            <h2 className="section-title">Add to my phone calendar</h2>
            <p className="hint">Downloads a calendar file with the title, the time and your notes. Open it on your phone to add it. Nothing else about the customer goes in it.</p>
            <a className="btn btn-primary" href={`/api/calendar/ics?id=${encodeURIComponent(a.id)}`} download>Download calendar file</a>
          </div>
          {a.customerName || a.quoteNumber ? (
            <div className="doc-side-panel">
              <h2 className="section-title">Linked to</h2>
              {a.customerName ? <p>{a.customerName}</p> : null}
              {a.quoteNumber ? <p><Link href={jobHref(a.quoteNumber)} className="mn-doc-link">Quote {a.quoteNumber}</Link></p> : null}
            </div>
          ) : null}
          <DeleteAppointment id={a.id} title={a.title} />
        </aside>
      </div>
      <p className="cust-back"><Link href={`/calendar?view=agenda&d=${day}`}>Back to the calendar</Link></p>
    </div>
  );
}
