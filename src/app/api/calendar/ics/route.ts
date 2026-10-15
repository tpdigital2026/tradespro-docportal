import { NextResponse } from 'next/server';
import { buildIcs, icsFilename, type IcsEvent } from '../../../../lib/calendar/ics';
import { instantsFor } from '../../../../lib/calendar/views';
import { getAppointment, isAppointmentId, listAppointments } from '../../../../lib/data/appointments';
import { daysInMonth, isMonth, monthLabel } from '../../../../lib/london';
import { getSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Calendar files: ?id= for one appointment, ?m=yyyy-mm for a month. The business comes from the session. Only the
 * title and notes the owner typed go in (src/lib/calendar/ics.ts).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, message: 'Please sign in.' }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const id = sp.get('id');
  const m = sp.get('m');
  let events: IcsEvent[];
  let name: string;
  let calName: string | undefined;
  try {
    if (id) {
      if (!isAppointmentId(id)) return NextResponse.json({ ok: false, message: 'That appointment could not be found.' }, { status: 404 });
      const a = await getAppointment(id);
      if (!a) return NextResponse.json({ ok: false, message: 'That appointment could not be found.' }, { status: 404 });
      events = [{ id: a.id, title: a.title, startsAt: a.startsAt, endsAt: a.endsAt, notes: a.notes, stamp: a.updatedAt }];
      name = icsFilename(a.title);
    } else if (isMonth(m)) {
      const { from, to } = instantsFor(`${m}-01`, `${m}-${String(daysInMonth(m)).padStart(2, '0')}`);
      const list = await listAppointments(from, to);
      const stamp = new Date().toISOString();
      events = list.map((a) => ({ id: a.id, title: a.title, startsAt: a.startsAt, endsAt: a.endsAt, notes: a.notes, stamp }));
      name = icsFilename(`appointments-${m}`);
      calName = `Appointments, ${monthLabel(m)}`;
    } else {
      return NextResponse.json({ ok: false, message: 'Choose an appointment or a month.' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ ok: false, message: 'The calendar file could not be made just now. Please try again.' }, { status: 500 });
  }
  return new Response(buildIcs(events, calName), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
