import type { QuoteErrors, QuoteFormValues, QuoteStep } from '../../lib/validation/quote';
import type { QuoteContext } from '../../lib/data/quotes';
import type { QuoteTotals } from '../../lib/quote-totals';

export interface StepProps {
  values: QuoteFormValues;
  set: (patch: Partial<QuoteFormValues>) => void;
  /** Error for a form key, shown only once the owner has touched the field or tried to move on. */
  err: (key: string) => string | undefined;
  touch: (key: string) => void;
  ctx: QuoteContext;
  totals: QuoteTotals;
  locked: boolean;
}

export type { QuoteErrors, QuoteFormValues, QuoteStep };
