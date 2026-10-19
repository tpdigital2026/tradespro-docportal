/**
 * The facts behind Pipeline, Money and Guarantees: jobs, their documents (with what the issued versions stored) and the
 * recorded payments. Read on a service connection with the tenant taken from the session and every query filtered by it
 * explicitly (the same pattern as the Documents library). Demo mode builds the same shapes from dummy data.
 */
import 'server-only';
import { cache } from 'react';
import { isDemo } from '../demo';
import { docTypeFromDb, type DocStatus } from '../job-stage';
import { planFromJson } from '../payment-plan';
import { requireSession } from '../session';
import { isLive, storedGross, storedSchedule, type FactDocument, type FactPayment, type JobFacts } from '../business/facts';
import type { InvoiceTotalsLine } from '../business/money-board';
import { withServiceConnection } from './customer-admin';
import { demoBusinessFacts } from '../demo-business';
import type { Db } from '../../security/login-guard';

/** Enough for any one business's working set; the screens say so if a business ever has more. */
export const JOB_LIMIT = 1000;

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
/** node-postgres turns a SQL date into local midnight, so read it back with local getters (toISOString would shift it a day in summer). */
const isoDate = (v: unknown): string =>
  v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10);
const STATUSES: readonly string[] = ['draft', 'final', 'sent', 'void'];
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const years = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,2}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};

export interface BusinessFacts {
  jobs: JobFacts[];
  /** More jobs exist than were read. */
  truncated: boolean;
  /** Demo jobs that have no job page to link to. */
  noJobPage: ReadonlySet<string>;
}

/**
 * Every job of the business with its documents and payments. Only the parts of issued versions that the screens need
 * are read: the quote's stored money, an invoice's printed due wording, a guarantee's years and certificate number.
 */
export async function loadBusinessFactsSql(db: Db, tenantId: string, limit = JOB_LIMIT): Promise<BusinessFacts> {
  const jobsRes = await db.query(
    `select j.id, j.reference, j.customer_id, j.property_address, j.payment_plan, c.name as customer
       from public.jobs j
       join public.customers c on c.id = j.customer_id and c.tenant_id = j.tenant_id
      where j.tenant_id = $1
      order by j.created_at desc, j.id
      limit $2`,
    [tenantId, limit + 1],
  );
  const truncated = jobsRes.rows.length > limit;
  const jobRows = jobsRes.rows.slice(0, limit);
  if (jobRows.length === 0) return { jobs: [], truncated: false, noJobPage: new Set() };
  const ids = jobRows.map((j) => String(j.id));

  const docsRes = await db.query(
    `select d.id, d.job_id, d.type::text as type, d.number, d.status::text as status, d.doc_date, d.finalised_at, d.total_pence,
            case when d.type = 'quotation' then v.money end as money,
            v.finalised_at as version_finalised_at,
            coalesce(v.final_content -> 'content' -> 'input' ->> 'dueNote', v.final_content -> 'content' -> 'input' ->> 'dueLabel') as due_wording,
            case when d.type = 'guarantee' then v.final_content -> 'content' -> 'input' -> 'years' end as years,
            case when d.type = 'guarantee' then v.final_content -> 'content' -> 'input' ->> 'certificateNo' end as certificate_no
       from public.documents d
       left join public.document_versions v
         on v.id = d.current_version_id and v.tenant_id = d.tenant_id and v.finalised_at is not null and d.status <> 'draft'
      where d.tenant_id = $1 and d.job_id = any ($2::uuid[])
      order by d.created_at, d.id`,
    [tenantId, ids],
  );
  const payRes = await db.query(
    `select p.id, p.job_id, p.document_id, p.amount_pence, p.paid_on, p.method, p.created_at, p.receipt_document_id
       from public.payments p
      where p.tenant_id = $1 and p.job_id = any ($2::uuid[])
      order by p.created_at, p.id`,
    [tenantId, ids],
  );

  const jobs: JobFacts[] = jobRows.map((j) => {
    const mine = docsRes.rows.filter((d) => String(d.job_id) === String(j.id));
    const documents: FactDocument[] = [];
    let quote: JobFacts['quote'] = null;
    let draftQuoteId: string | null = null;
    for (const d of mine) {
      const type = docTypeFromDb(String(d.type));
      if (!type || !STATUSES.includes(String(d.status))) continue;
      const status = String(d.status) as DocStatus;
      const live = status === 'final' || status === 'sent';
      documents.push({
        id: String(d.id),
        type,
        number: String(d.number),
        status,
        docDate: isoDate(d.doc_date),
        finalisedAt: live ? (iso(d.version_finalised_at) ?? iso(d.finalised_at)) : null,
        totalPence: live && d.total_pence !== null ? Number(d.total_pence) : null,
        dueWording: live ? str(d.due_wording) : null,
        guaranteeYears: live ? years(d.years) : null,
        certificateNo: live ? str(d.certificate_no) : null,
      });
      if (type === 'quotation') {
        if (status === 'draft') draftQuoteId = String(d.id);
        else if (live) {
          const gross = storedGross(d.money) ?? (d.total_pence !== null ? Number(d.total_pence) : null);
          const issuedAt = iso(d.version_finalised_at) ?? iso(d.finalised_at);
          if (gross !== null && issuedAt) quote = { documentId: String(d.id), issuedAt, grossPence: gross, schedule: storedSchedule(d.money) };
        }
      }
    }
    const payments: FactPayment[] = payRes.rows
      .filter((p) => String(p.job_id) === String(j.id))
      .map((p) => ({
        id: String(p.id),
        documentId: String(p.document_id),
        amountPence: Number(p.amount_pence),
        paidOn: isoDate(p.paid_on),
        method: String(p.method),
        recordedAt: iso(p.created_at) ?? '',
        receiptDocumentId: p.receipt_document_id ? String(p.receipt_document_id) : null,
      }));
    return {
      jobId: String(j.id),
      quoteNumber: String(j.reference),
      customerId: String(j.customer_id),
      customerName: String(j.customer),
      addressLine: j.property_address ? String(j.property_address) : '',
      planKind: planFromJson(j.payment_plan)?.plan.kind ?? null,
      quote,
      draftQuoteId,
      documents,
      payments,
    };
  });
  return { jobs, truncated, noJobPage: new Set() };
}

/** What the Pipeline, Money and Guarantees screens call: session first, tenant from it. Read once per request. */
export const getBusinessFacts: () => Promise<BusinessFacts> = cache(async () => {
  const s = await requireSession();
  if (isDemo()) return demoBusinessFacts();
  return withServiceConnection((db) => loadBusinessFactsSql(db, s.tenantId));
});

/**
 * For the Home money strip: only the issued invoices (stored total, what was paid on each, printed due wording),
 * summed in one query, so Home never loads every job.
 */
export async function loadInvoiceTotalsSql(db: Db, tenantId: string): Promise<InvoiceTotalsLine[]> {
  const r = await db.query(
    `select d.doc_date, d.total_pence,
            coalesce((select sum(p.amount_pence) from public.payments p where p.tenant_id = d.tenant_id and p.document_id = d.id), 0)::bigint as paid,
            coalesce(v.final_content -> 'content' -> 'input' ->> 'dueNote', v.final_content -> 'content' -> 'input' ->> 'dueLabel') as due_wording
       from public.documents d
       left join public.document_versions v on v.id = d.current_version_id and v.tenant_id = d.tenant_id and v.finalised_at is not null
      where d.tenant_id = $1 and d.status in ('final', 'sent') and d.total_pence is not null
        and d.type in ('deposit_invoice', 'balance_invoice', 'invoice_full', 'invoice_stage')`,
    [tenantId],
  );
  return r.rows.map((x) => ({ docDate: isoDate(x.doc_date), grossPence: Number(x.total_pence), paidPence: Number(x.paid), dueWording: str(x.due_wording) }));
}

export async function getInvoiceTotals(): Promise<InvoiceTotalsLine[]> {
  const s = await requireSession();
  if (isDemo()) {
    return demoBusinessFacts().jobs.flatMap((j) =>
      j.documents
        .filter((d) => isLive(d.status) && d.totalPence !== null && ['deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage'].includes(d.type))
        .map((d) => ({ docDate: d.docDate, grossPence: d.totalPence as number, paidPence: j.payments.filter((p) => p.documentId === d.id).reduce((t, p) => t + p.amountPence, 0), dueWording: d.dueWording })),
    );
  }
  return withServiceConnection((db) => loadInvoiceTotalsSql(db, s.tenantId));
}
