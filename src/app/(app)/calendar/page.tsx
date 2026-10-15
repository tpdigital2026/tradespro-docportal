import type { Metadata } from 'next';
import Link from 'next/link';
import { ButtonLink } from '../../../components/Button';
import { EmptyState } from '../../../components/EmptyState';
import { PageHeader } from '../../../components/PageHeader';
import { kindLabel, timeRange, type Appointment } from '../../../lib/calendar/model';
import { AGENDA_DAYS, agendaDays, byDay, calendarHref, instantsFor, monthWeeks, parseCalendarParams, stepHref, viewSpan, weekDays, type CalendarParams, type CalendarView } from '../../../lib/calendar/views';
import { listAppointments } from '../../../lib/data/appointments';
import { isDemo } from '../../../lib/demo';
import { addDays, dayLabel, londonDate, monthLabel, monthOf, shortDate, todayLondon, WEEKDAY_LONG, WEEKDAY_SHORT } from '../../../lib/london';
import { requireSession } from '../../../lib/session';
import '../../../styles/business.css';

export const metadata: Metadata = { title: 'Calendar', description: 'Your site visits, surveys and job dates, with a file to add each one to your phone.' };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const MAX_IN_CELL = 3;

function ApptLink({ a, day, compact }: { a: Appointment; day: string; compact?: boolean }) {
  const starts = londonDate(a.startsAt) === day;
  return (
    <Link href={`/calendar/${a.id}`} className={`cal-appt is-${a.kind}${compact ? ' is-compact' : ''}`}>
      <span className="cal-appt-time">{starts ? timeRange(a).slice(0, 5) : 'On'}</span>
      <span className="cal-appt-title">{a.title}</span>
    </Link>
  );
}

function MonthGrid({ p, days, today }: { p: CalendarParams; days: Map<string, Appointment[]>; today: string }) {
  const weeks = monthWeeks(p.month);
  return (
    <table className="cal-month">
      <caption className="sr-only">{monthLabel(p.month)}</caption>
      <thead>
        <tr>{WEEKDAY_SHORT.map((d, i) => <th key={d} scope="col"><abbr title={WEEKDAY_LONG[i]}>{d}</abbr></th>)}</tr>
      </thead>
      <tbody>
        {weeks.map((w) => (
          <tr key={w[0]}>
            {w.map((d) => {
              const list = days.get(d) ?? [];
              const out = monthOf(d) !== p.month;
              return (
                <td key={d} className={`${out ? 'is-out' : ''}${d === today ? ' is-today' : ''}`} aria-current={d === today ? 'date' : undefined}>
                  <Link href={calendarHref({ view: 'agenda', day: d })} className="cal-daynum" aria-label={`${dayLabel(d, true)}${d === today ? ', today' : ''}, ${list.length ? `${list.length} ${list.length === 1 ? 'appointment' : 'appointments'}` : 'nothing booked'}`}>
                    {Number(d.slice(8, 10))}
                  </Link>
                  {list.length ? (
                    <ul className="cal-cell-list">
                      {list.slice(0, MAX_IN_CELL).map((a) => <li key={a.id}><ApptLink a={a} day={d} compact /></li>)}
                      {list.length > MAX_IN_CELL ? (
                        <li><Link href={calendarHref({ view: 'agenda', day: d })} className="cal-more">{list.length - MAX_IN_CELL} more</Link></li>
                      ) : null}
                    </ul>
                  ) : null}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DayItems({ list, day }: { list: Appointment[]; day: string }) {
  return (
    <ul className="cal-items">
      {list.map((a) => (
        <li key={`${a.id}-${day}`} className={`cal-item is-${a.kind}`}>
          <p className="cal-item-time">{timeRange(a)}</p>
          <div className="cal-item-main">
            <p className="cal-item-title"><Link href={`/calendar/${a.id}`} className="cal-item-link">{a.title}</Link></p>
            <p className="cal-item-meta">
              <span className={`cal-kind-chip is-${a.kind}`}>{kindLabel(a.kind)}</span>
              {a.customerName ? <span>{a.customerName}</span> : null}
              {a.quoteNumber ? <span>Quote {a.quoteNumber}</span> : null}
            </p>
          </div>
          <a className="cal-ics" href={`/api/calendar/ics?id=${encodeURIComponent(a.id)}`} download aria-label={`Add ${a.title} to my phone calendar`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1zM12 12v5M9.5 14.5h5" /></svg>
            <span>Add to phone</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Agenda({ p, days, today }: { p: CalendarParams; days: Map<string, Appointment[]>; today: string }) {
  const shown = agendaDays(p.day).filter((d) => (days.get(d) ?? []).length > 0);
  const end = addDays(p.day, AGENDA_DAYS - 1);
  return (
    <div className="cal-agenda">
      {shown.length ? (
        shown.map((d) => (
          <section key={d} className={`cal-day${d === today ? ' is-today' : ''}`} aria-labelledby={`day-${d}`}>
            <h2 id={`day-${d}`} className="cal-day-h" aria-current={d === today ? 'date' : undefined}>
              {d === today ? <span className="cal-today-tag">Today</span> : d === addDays(today, 1) ? <span className="cal-today-tag is-soft">Tomorrow</span> : null}
              {dayLabel(d, d.slice(0, 4) !== today.slice(0, 4))}
            </h2>
            <DayItems list={days.get(d) ?? []} day={d} />
          </section>
        ))
      ) : (
        <EmptyState icon="drafts" title="Nothing booked" compact action={<ButtonLink href={`/calendar/new?d=${p.day < today ? today : p.day}`} variant="secondary">Add an appointment</ButtonLink>}>
          Nothing between {shortDate(p.day)} and {shortDate(end)}.
        </EmptyState>
      )}
    </div>
  );
}

function Week({ p, days, today }: { p: CalendarParams; days: Map<string, Appointment[]>; today: string }) {
  return (
    <ol className="cal-week">
      {weekDays(p.day).map((d) => {
        const list = days.get(d) ?? [];
        return (
          <li key={d} className={`cal-wday${d === today ? ' is-today' : ''}`}>
            <h2 className="cal-wday-h" aria-current={d === today ? 'date' : undefined}>
              <span className="cal-wday-name">{WEEKDAY_LONG[weekDays(p.day).indexOf(d)]}</span>
              <span className="cal-wday-date">{shortDate(d, false)}</span>
              {d === today ? <span className="cal-today-tag">Today</span> : null}
            </h2>
            {list.length ? <DayItems list={list} day={d} /> : <p className="cal-free">Nothing booked</p>}
          </li>
        );
      })}
    </ol>
  );
}

function Toolbar({ p, view, today }: { p: CalendarParams; view: CalendarView; today: string }) {
  const label = view === 'month' ? monthLabel(p.month) : view === 'week' ? `Week of ${shortDate(weekDays(p.day)[0])}` : `From ${shortDate(p.day)}`;
  const todayHref = calendarHref({ view, month: monthOf(today), day: today });
  return (
    <div className={`cal-bar is-${view}`}>
      <div className="cal-step">
        <Link href={stepHref(p, view, -1)} className="btn btn-secondary cal-step-btn" aria-label={view === 'month' ? 'Previous month' : view === 'week' ? 'Previous week' : 'Earlier'}><span aria-hidden="true">&lsaquo;</span></Link>
        <Link href={todayHref} className="btn btn-secondary cal-today-btn">Today</Link>
        <Link href={stepHref(p, view, 1)} className="btn btn-secondary cal-step-btn" aria-label={view === 'month' ? 'Next month' : view === 'week' ? 'Next week' : 'Later'}><span aria-hidden="true">&rsaquo;</span></Link>
        <p className="cal-label" aria-live="polite">{label}</p>
      </div>
    </div>
  );
}

function ViewSwitch({ p, current }: { p: CalendarParams; current: CalendarView | 'auto' }) {
  const items: { view: CalendarView; label: string }[] = [
    { view: 'agenda', label: 'List' },
    { view: 'week', label: 'Week' },
    { view: 'month', label: 'Month' },
  ];
  return (
    <nav aria-label="Calendar view" className="lib-filters cal-views">
      <ul>
        {items.map((i) => (
          <li key={i.view}>
            <Link href={calendarHref({ view: i.view, month: p.month, day: i.view === 'agenda' && current !== 'agenda' ? (monthOf(p.day) === p.month ? p.day : `${p.month}-01`) : p.day })} className="filter-chip" aria-current={current === i.view ? 'true' : undefined}>
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const sp = await searchParams;
  const today = todayLondon();
  const p = parseCalendarParams(sp, today);
  // No view chosen: the month on wide screens, the list (from today) on phones. Both come from one read.
  const views: CalendarView[] = p.view === 'auto' ? ['month', 'agenda'] : [p.view];
  const spans = views.map((v) => viewSpan(p.view === 'auto' && v === 'agenda' ? { ...p, day: today } : p, v));
  const firstDay = spans.map((s) => s.first).sort()[0];
  const lastDay = spans.map((s) => s.last).sort().reverse()[0];
  let list: Appointment[] | null = null;
  try {
    const { from, to } = instantsFor(firstDay, lastDay);
    list = await listAppointments(from, to);
  } catch {
    list = null;
  }
  const days = byDay(list ?? []);
  const saved = typeof first(sp.saved) === 'string';
  const deleted = first(sp.deleted) === '1';
  const icsMonth = p.view === 'month' || p.view === 'auto' ? p.month : monthOf(p.day);

  return (
    <div className="page page-wide">
      <PageHeader
        muted="Your"
        title="calendar"
        lede="Site visits, surveys and job dates. Add any of them to the calendar on your phone. There are no reminders from here."
        action={<ButtonLink href={`/calendar/new?d=${p.view === 'auto' || p.day < today ? today : p.day}`}>Add appointment</ButtonLink>}
      />
      {isDemo() ? <p className="demo-chip">Demo mode. Everything here is dummy data.</p> : null}
      {saved ? <p className="flash is-done" role="status">Appointment saved.</p> : null}
      {deleted ? <p className="flash is-done" role="status">Appointment deleted.</p> : null}

      {list === null ? (
        <p className="form-error" role="alert">We could not load your calendar just now. Please try again.</p>
      ) : (
        <>
          <a className="cal-month-ics" href={`/api/calendar/ics?m=${icsMonth}`} download>
            Add {monthLabel(icsMonth)} to my phone calendar
          </a>
          {p.view === 'auto' ? (
            <>
              <div className="cal-wide">
                <ViewSwitch p={p} current="month" />
                <Toolbar p={p} view="month" today={today} />
                <MonthGrid p={p} days={days} today={today} />
              </div>
              <div className="cal-narrow">
                <ViewSwitch p={p} current="agenda" />
                <Toolbar p={{ ...p, day: today }} view="agenda" today={today} />
                <Agenda p={{ ...p, day: today }} days={days} today={today} />
              </div>
            </>
          ) : (
            <>
              <ViewSwitch p={p} current={p.view} />
              <Toolbar p={p} view={p.view} today={today} />
              {p.view === 'month' ? <div className="cal-month-wrap"><MonthGrid p={p} days={days} today={today} /></div> : p.view === 'week' ? <Week p={p} days={days} today={today} /> : <Agenda p={p} days={days} today={today} />}
            </>
          )}
        </>
      )}
    </div>
  );
}
