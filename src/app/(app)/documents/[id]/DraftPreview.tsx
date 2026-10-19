'use client';

import { ReviewPreview } from '../../../../components/quote/ReviewPreview';

/**
 * Page 1 of a saved draft on its draft page, so an invoice, receipt, survey report or quote is seen as the customer
 * will see it before Preview and finalise. The draft is already saved here, so the id is known. For a quote, anything
 * missing links to the step of the quote that puts it right.
 */
export function DraftPreview({ id, noun, quoteJobId }: { id: string; noun: string; quoteJobId: string | null }) {
  return (
    <ReviewPreview
      watch={id}
      noun={noun}
      headingLevel={2}
      getDocumentId={async () => id}
      fixHref={quoteJobId ? (step) => `/documents/new?type=quotation&draft=${encodeURIComponent(quoteJobId)}&step=${step}` : undefined}
    />
  );
}
