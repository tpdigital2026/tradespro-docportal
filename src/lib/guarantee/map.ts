/**
 * From a stored guarantee draft to what the certificate template prints. Pure.
 *
 * Nothing is invented: the guarantee wording comes from the business's own tenant data, the roof, years, address and
 * completion date from the owner. A missing or invalid fact blocks the preview and finalising with a plain message.
 * The completion date must be a real date that is not in the future (London, today passed in).
 */
import type { GuaranteeInput } from '../../templates/guarantee';
import { slashDate, type BusinessFacts } from '../documents/map';
import { guaranteeErrors, parseYears, roofWords, type GuaranteeValues } from './model';
import { templateFor } from '../../templates/registry';

/** The certificate template for the roof: the owner's 20 year flat roof and 25 year tiled roof certificates (FJC_13, FJC_14). */
function guaranteeTemplate(b: BusinessFacts, roof: string): { template: string } | Record<string, never> {
  const variant = roof === 'flat' ? 'flat-roof' : roof === 'tiled' || roof === 'pitched' ? 'tiled-roof' : null;
  const tpl = templateFor(b.slug, 'guarantee', variant);
  return tpl ? { template: tpl.id } : {};
}

export interface GuaranteeFacts {
  number: string;
  /** The job number the certificate belongs to. */
  jobReference: string;
  customerName: string;
  /** null when the draft holds nothing readable. */
  values: GuaranteeValues | null;
}

export type GuaranteeMapResult = { ok: true; input: GuaranteeInput } | { ok: false; missing: string[] };

const NOT_SET_UP = 'Contact TradesPro Digital to set it up.';

export function mapGuarantee(f: GuaranteeFacts, b: BusinessFacts, today: string): GuaranteeMapResult {
  const missing: string[] = [];
  const v = f.values;
  if (!v) return { ok: false, missing: ['This certificate has nothing saved in it yet. Open it and fill it in.'] };
  missing.push(...Object.values(guaranteeErrors(v, today)));
  const wording = b.wording?.guarantee;
  if (!wording || !wording.statement.trim()) missing.push(`Your guarantee wording is not set up yet. ${NOT_SET_UP}`);
  const years = parseYears(v.years);
  const completedLabel = slashDate(v.completedOn);
  if (missing.length > 0 || !wording || years === null || !completedLabel) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    input: {
      ...guaranteeTemplate(b, v.roofType),
      certificateNo: f.number,
      years,
      workDescription: roofWords(v),
      address: v.address,
      completedLabel,
      statement: wording.statement.trim(),
      disclaimerLine: wording.disclaimerLine?.trim() ? wording.disclaimerLine.trim() : null,
    },
  };
}
