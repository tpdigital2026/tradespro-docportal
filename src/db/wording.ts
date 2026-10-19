import { z } from 'zod';

const text = z.string().trim().min(1);

/**
 * A business's survey report wording: the kind of report (a tenant data field, not code) and the fixed text around
 * the owner's findings. {business} becomes the business name; {ref} in quoteLink becomes the survey report number.
 */
export const surveyWordingSchema = z.strictObject({
  reportType: text.max(80),
  title: text.max(60),
  runningLabel: text.max(60),
  coverSub: text.max(200).optional(),
  purpose: text.max(300).optional(),
  intro: text.max(1200),
  howToRead: text.max(400).optional(),
  quoteLink: text.max(200).optional(),
});
export type SurveyWording = z.infer<typeof surveyWordingSchema>;

/** Document wording owned by each business (terms, due labels, guarantee wording). Never written by code. */
export const tenantWordingSchema = z.strictObject({
  quote: z.strictObject({ terms: text }),
  deposit_invoice: z.strictObject({ terms: text, dueLabel: text, balanceDueLabel: text }),
  /** dueLabel is the header's "Due" line ("On receipt"). Without it the row is left out: it is never invented. */
  balance_invoice: z.strictObject({ terms: text, dueNote: text, dueLabel: text.max(60).optional() }),
  /** Optional. Without it, a full invoice uses the business's balance invoice wording (both are paid on receipt). */
  invoice_full: z.strictObject({ terms: text, dueNote: text, dueLabel: text.max(60).optional() }).optional(),
  /** Optional. Without it, a stage invoice uses the business's balance invoice wording. */
  invoice_stage: z.strictObject({ terms: text, dueNote: text, dueLabel: text.max(60).optional() }).optional(),
  /**
   * Optional. What the "Payment reference" on an invoice's pay card says: the first line of the job's address (the default,
   * so the owner can match a bank credit to a job) or the invoice number. With no job address the invoice number is used.
   */
  paymentReference: z.enum(['address_line_1', 'invoice_number']).optional(),
  /**
   * Optional. The confirmation the owner ticks before a document is finalised. Without it the default wording in
   * src/lib/documents/confirmation.ts is used (draft wording, to be reviewed by a solicitor before wider use).
   */
  confirmation: z.strictObject({ text: text.max(600), version: z.string().regex(/^[a-z0-9-]{1,20}$/) }).optional(),
  receipt: z.strictObject({ balanceDueLabel: text }),
  guarantee: z.strictObject({ statement: text, disclaimerLine: text.nullable() }),
  /** Optional. The survey report's wording (src/lib/survey/wording.ts). Without it a survey report cannot be finalised. */
  survey: surveyWordingSchema.optional(),
});

export type TenantWording = z.infer<typeof tenantWordingSchema>;

/**
 * FJC's survey report wording, verbatim from its pre-contract roof defect survey report, with the business name as
 * {business}. Left out on purpose: that report's sub-title and purpose line describe one particular job (works by a
 * previous contractor) and are not true of every survey. The quote link is the owner's wording (2026-10-14 brief).
 */
export const FJC_SURVEY_WORDING: SurveyWording = {
  reportType: 'Pre-contract roof defect survey report',
  title: 'Roof Defect Survey Report',
  runningLabel: 'Pre-Contract Roof Defect Survey',
  intro:
    'This report has been prepared by {business} following an inspection of the roof at the above property, carried out prior to {business} undertaking any remedial works. The purpose of this survey is to record, by way of photographic evidence and professional commentary, the condition of the roof as found.',
  howToRead: 'Each finding is set out on its own page with site photographs, followed by what was observed on the roof and our professional assessment.',
  quoteLink: 'Read alongside survey report {ref}',
};

/** FJC's own wording, taken verbatim from its existing documents (tests/fixtures). */
export const FJC_WORDING: TenantWording = {
  quote: {
    terms:
      'This quotation is valid for 30 days from the date above. All materials supplied and installed as part of this contract remain the property of FJC Roofing Ltd until paid for in full.',
  },
  deposit_invoice: {
    // {balance} becomes the amount still to pay after the deposit.
    terms: 'The 30% deposit is payable before works start. The remaining balance of {balance} is due on completion of works.',
    dueLabel: 'Before works start',
    balanceDueLabel: 'Balance due on completion',
  },
  balance_invoice: {
    terms: 'Payment is due upon receipt of this invoice.',
    dueNote: 'Payment is due upon receipt of this invoice',
    dueLabel: 'On receipt',
  },
  paymentReference: 'address_line_1',
  receipt: { balanceDueLabel: 'Due on completion of works' },
  guarantee: {
    statement: 'Any defect in installation that occurs within this period will be repaired at no cost to the customer.',
    disclaimerLine: 'We cannot be held responsible for misuse of our products by the customer',
  },
  survey: FJC_SURVEY_WORDING,
};
