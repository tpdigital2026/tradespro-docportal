/**
 * From a stored survey draft to what the survey template prints. Pure.
 *
 * Photos are carried as references (id, storage path, fingerprint, size), never as bytes: the content key and the
 * finalised record stay small, and any change to a photo changes its fingerprint and so the key. The render step
 * (src/lib/survey/render.ts) reads the files.
 *
 * Nothing is invented: the business's wording comes from its own tenant data, the rest from the owner. A missing
 * fact blocks finalising with a plain message.
 */
import type { SurveyWording } from '../../db/wording';
import type { Tenant } from '../../themes/types';
import type { SurveyInput } from '../../templates/survey';
import { longDate } from '../documents/map';
import { paragraphs, surveyProblems, tidyLine, tidyPara, type SurveyFormValues } from './model';

export interface PhotoRef {
  id: string;
  path: string;
  sha256: string;
  width: number;
  height: number;
}

export interface SurveyFacts {
  number: string;
  jobReference: string;
  customerName: string;
  /** null when the draft holds nothing readable. */
  form: SurveyFormValues | null;
  /** The photos stored for this survey's job, by id. */
  photos: Record<string, PhotoRef>;
}

/** The template input with photos as references. */
export type SurveyMappedInput = Omit<SurveyInput, 'findings' | 'coverPhoto'> & {
  coverPhoto: PhotoRef | null;
  findings: (Omit<SurveyInput['findings'][number], 'photos'> & { photos: PhotoRef[] })[];
};

export type SurveyMapResult = { ok: true; input: SurveyMappedInput } | { ok: false; missing: string[] };

const NOT_SET_UP = 'Contact TradesPro Digital to set it up.';

export const fillBusiness = (text: string, business: string): string => text.replaceAll('{business}', business);

/** The quote's "read alongside" line, from the business's wording, or null when it has none. */
export function quoteLinkLine(wording: SurveyWording | null | undefined, surveyNumber: string): string | null {
  const t = wording?.quoteLink?.trim();
  return t ? t.replaceAll('{ref}', surveyNumber) : null;
}

export function mapSurvey(f: SurveyFacts, tenant: Tenant, wording: SurveyWording | null | undefined): SurveyMapResult {
  const missing: string[] = [];
  if (!wording) missing.push(`Your survey report wording is not set up yet. ${NOT_SET_UP}`);
  const v = f.form;
  if (!v) return { ok: false, missing: [...missing, 'This survey has nothing saved in it yet. Open it and fill it in.'] };
  missing.push(...surveyProblems(v));
  if (!f.customerName.trim()) missing.push('The customer has no name.');
  const ref = (id: string, where: string): PhotoRef | null => {
    const p = f.photos[id];
    if (!p) missing.push(`A photo in ${where} is no longer stored. Remove it and add it again.`);
    return p ?? null;
  };
  const findings = v.findings.map((x, i) => ({
    title: tidyLine(x.title),
    observation: paragraphs(x.observation),
    assessment: paragraphs(x.assessment),
    photos: x.photoIds.map((id) => ref(id, `finding ${i + 1}`)).filter((p): p is PhotoRef => p !== null),
  }));
  const cover = v.coverPhotoId ? ref(v.coverPhotoId, 'the cover') : null;
  const dateLabel = longDate(v.surveyDate);
  const signDateLabel = longDate(v.signDate);
  if (v.surveyDate && !dateLabel) missing.push('The survey date is not a real date.');
  if (v.signDate && !signDateLabel) missing.push('The signature date is not a real date.');
  if (missing.length > 0 || !wording) return { ok: false, missing: [...new Set(missing)] };

  const signName = tidyLine(v.signName);
  const preparedBy = tidyLine(v.preparedBy);
  const isOwner = signName.toLocaleLowerCase('en-GB') === tenant.ownerName.trim().toLocaleLowerCase('en-GB');
  return {
    ok: true,
    input: {
      number: f.number,
      reportType: wording.reportType,
      title: wording.title,
      runningLabel: wording.runningLabel,
      coverSub: wording.coverSub ?? null,
      purpose: wording.purpose ? fillBusiness(wording.purpose, tenant.name) : null,
      intro: paragraphs(fillBusiness(wording.intro, tenant.name)),
      howToRead: wording.howToRead ? fillBusiness(wording.howToRead, tenant.name) : null,
      customerName: f.customerName.trim(),
      property: tidyPara(v.propertyAddress).replace(/\n+/g, ', '),
      dateLabel,
      preparedBy: `${preparedBy}, ${tenant.name}`,
      coverPhoto: cover,
      findings,
      opinion: paragraphs(v.opinion),
      remedial: tidyLine(v.remedial) || null,
      signName,
      signRole: isOwner && tenant.ownerTitle ? `${tenant.ownerTitle} · ${tenant.name}` : tenant.name,
      signDateLabel,
    },
  };
}
