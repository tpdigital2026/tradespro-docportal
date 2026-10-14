import { z } from 'zod';

const text = z.string().trim().min(1);

/** Document wording owned by each business (terms, due labels, guarantee wording). Never written by code. */
export const tenantWordingSchema = z.strictObject({
  quote: z.strictObject({ terms: text }),
  deposit_invoice: z.strictObject({ terms: text, dueLabel: text, balanceDueLabel: text }),
  balance_invoice: z.strictObject({ terms: text, dueNote: text }),
  receipt: z.strictObject({ balanceDueLabel: text }),
  guarantee: z.strictObject({ statement: text, disclaimerLine: text.nullable() }),
});

export type TenantWording = z.infer<typeof tenantWordingSchema>;

/** FJC's own wording, taken verbatim from its existing documents (tests/fixtures). */
export const FJC_WORDING: TenantWording = {
  quote: {
    terms:
      'This quotation is valid for 30 days from the date above. All materials supplied and installed as part of this contract remain the property of FJC Roofing Ltd until paid for in full.',
  },
  deposit_invoice: {
    terms: 'The 30% deposit is payable before works start. The remaining balance is due on completion of works.',
    dueLabel: 'Before works start',
    balanceDueLabel: 'Balance due on completion',
  },
  balance_invoice: {
    terms: 'Payment is due upon receipt of this invoice.',
    dueNote: 'Payment is due upon receipt of this invoice',
  },
  receipt: { balanceDueLabel: 'Due on completion of works' },
  guarantee: {
    statement: 'Any defect in installation that occurs within this period will be repaired at no cost to the customer.',
    disclaimerLine: 'We cannot be held responsible for misuse of our products by the customer',
  },
};
