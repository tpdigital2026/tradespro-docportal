import Link from 'next/link';
import { DocTypeIcon } from './DocTypeIcon';
import { newDocumentHref, type DocType } from '../lib/job-stage';

type Group = 'start' | 'paid' | 'finish';
type Item = { type: DocType; name: string; blurb: string; group: Group };

const GROUP_LABEL: Record<Group, string> = { start: 'Start a job', paid: 'Get paid', finish: 'Finish up' };

// In the order a job runs. Quotation is the one primary action; the others are tinted by what they are for.
const items: Item[] = [
  { type: 'quotation', name: 'Quotation', blurb: 'Price the work for a customer. It saves as you go.', group: 'start' },
  { type: 'deposit-invoice', name: 'Deposit invoice', blurb: 'Ask for the deposit before work starts.', group: 'paid' },
  { type: 'balance-invoice', name: 'Balance invoice', blurb: 'Bill what is left once the job is done.', group: 'paid' },
  { type: 'invoice-full', name: 'Full invoice', blurb: 'Bill the whole job in one go, no deposit.', group: 'paid' },
  { type: 'invoice-stage', name: 'Stage invoice', blurb: 'Bill the next stage of a staged job.', group: 'paid' },
  { type: 'receipt', name: 'Receipt', blurb: 'Confirm a payment you have received.', group: 'paid' },
  { type: 'guarantee', name: 'Guarantee certificate', blurb: 'Hand over the guarantee for finished work.', group: 'finish' },
  { type: 'survey', name: 'Survey report', blurb: 'Record what you found on site.', group: 'finish' },
];

const Arrow = () => (
  <svg className="tile-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

/** The document picker: tinted tiles, grouped by colour (start, get paid, finish up), Quotation first and primary. */
export function DocTypeList() {
  return (
    <div className="tiles-wrap">
      <ul className="tile-key" aria-hidden="true">
        {(Object.keys(GROUP_LABEL) as Group[]).map((g) => (
          <li key={g} className={`is-${g}`}>{GROUP_LABEL[g]}</li>
        ))}
      </ul>
      <ul className="tiles">
        {items.map((i) => (
          <li key={i.type} className={`tile-cell is-${i.type}`}>
            <Link href={newDocumentHref(i.type)} className={`tile is-${i.group}`}>
              <span className="tile-icon"><DocTypeIcon type={i.type} /></span>
              <span className="tile-text">
                <span className="sr-only">{GROUP_LABEL[i.group]}: </span>
                <span className="tile-name">{i.name}</span>
                <span className="tile-blurb">{i.blurb}</span>
              </span>
              {i.group === 'start' ? (
                <span className="tile-cta" aria-hidden="true">Start a quote <Arrow /></span>
              ) : (
                <Arrow />
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
