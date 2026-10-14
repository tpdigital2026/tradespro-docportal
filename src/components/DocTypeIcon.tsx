import type { DocType } from '../lib/job-stage';

const paths: Record<DocType, string> = {
  quotation: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zM14 3v5h5M9 13h6M9 17h4',
  'deposit-invoice': 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h3',
  'balance-invoice': 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6M9 15.5h3',
  'invoice-full': 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6M9 16h6',
  'invoice-stage': 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6M9 16h2.5',
  receipt: 'M5 12.5l4.5 4.5L19 7.5M4 4h16v16H4z',
  guarantee: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zM9 12l2.2 2.2L15.5 10',
  survey: 'M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.5 15.5L20 20M10.5 7.5v3.5l2 1.5',
};

export function DocTypeIcon({ type }: { type: DocType }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[type]} />
    </svg>
  );
}
