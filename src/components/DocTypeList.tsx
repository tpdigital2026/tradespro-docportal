import Link from 'next/link';
import { DocTypeIcon } from './DocTypeIcon';
import { newDocumentHref, type DocType } from '../lib/job-stage';

type Item = { type: DocType; name: string; blurb: string };

const groups: { label: string; items: Item[] }[] = [
  {
    label: 'Start a job',
    items: [{ type: 'quotation', name: 'Quotation', blurb: 'Price the work for a new customer.' }],
  },
  {
    label: 'Get paid',
    items: [
      { type: 'deposit-invoice', name: 'Deposit invoice', blurb: 'Ask for the deposit before work begins.' },
      { type: 'balance-invoice', name: 'Balance invoice', blurb: 'Bill what remains once the job is done.' },
      { type: 'receipt', name: 'Receipt', blurb: 'Confirm a payment you have received.' },
    ],
  },
  {
    label: 'Finish up',
    items: [
      { type: 'guarantee', name: 'Guarantee certificate', blurb: 'Hand over the guarantee for the finished work.' },
      { type: 'survey', name: 'Survey report', blurb: 'Record what you found on site.' },
    ],
  },
];

export function DocTypeList() {
  return (
    <div className="picker">
      {groups.map((g) => (
        <div key={g.label} className="picker-group">
          <h3 className="group-label">{g.label}</h3>
          <ul className="rows">
            {g.items.map((i) => (
              <li key={i.type}>
                <Link href={newDocumentHref(i.type)} className="pick">
                  <span className="pick-icon"><DocTypeIcon type={i.type} /></span>
                  <span className="pick-text">
                    <span className="pick-name">{i.name}</span>
                    <span className="pick-blurb">{i.blurb}</span>
                  </span>
                  <svg className="pick-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
