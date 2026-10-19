/** What the draft and final pages say about a guarantee certificate, and where its form is. Pure. */
import type { SummarySection } from '../documents/summary';
import { longDate } from '../documents/map';
import { parseYears, roofLabel, type GuaranteeValues } from './model';

export const guaranteeEditHref = (documentId: string) => `/documents/new?type=guarantee&draft=${encodeURIComponent(documentId)}`;

/** issued: the date the certificate is issued (yyyy-mm-dd); for a draft this is today, as it is when finalised. */
export function guaranteeSummary(v: GuaranteeValues | null, customerName: string, number: string, jobReference: string, issued: { date: string; final: boolean }): SummarySection[] {
  const who = [{ label: 'Customer', value: customerName || 'Not given' }, ...(v && v.address.trim() ? [{ label: 'Roof at', value: v.address }] : [])];
  const years = v ? parseYears(v.years) : null;
  const cert: SummarySection['rows'] = [{ label: 'Certificate number', value: number }, { label: 'Job', value: jobReference }];
  if (v) {
    cert.push({ label: 'Roof', value: roofLabel(v) || 'Not chosen yet', ...(roofLabel(v) ? {} : { tone: 'warn' as const }) });
    cert.push(years === null ? { label: 'Guarantee', value: 'Years not entered yet', tone: 'warn' } : { label: 'Guarantee', value: `${years} ${years === 1 ? 'year' : 'years'}`, tone: 'strong' });
    cert.push(v.completedOn ? { label: 'Installation completed', value: longDate(v.completedOn) || 'Not a real date', ...(longDate(v.completedOn) ? {} : { tone: 'warn' as const }) } : { label: 'Installation completed', value: 'Not entered yet', tone: 'warn' });
    if (v.linkedQuote.trim()) cert.push({ label: 'Quote', value: v.linkedQuote.trim() });
  }
  cert.push({ label: issued.final ? 'Issued on' : 'Issue date', value: `${longDate(issued.date)}${issued.final ? '' : ' (set when you finalise)'}` });
  return [
    { title: 'Who it is for', rows: who },
    { title: 'The certificate', rows: cert },
  ];
}
