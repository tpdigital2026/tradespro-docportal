/**
 * The survey report form: what the owner enters, the limits, and the approval fingerprints. Pure, shared by the
 * browser and the server.
 *
 * Each finding is one to four photos and ONE line from the owner (typed or dictated). A draft (from the AI, or the
 * deterministic stub) fills the title, observation and assessment, which the owner then edits. Nothing goes on the
 * report until the owner has approved every finding and the professional opinion. Approval is made on the server only
 * (src/lib/data/surveys.ts): the server stores the time and a fingerprint of the exact words and photos, and writes an
 * audit row with that fingerprint. Any change to the words or photos no longer matches the fingerprint, so the
 * approval is gone.
 */
import { z } from 'zod';
import { sha256Hex } from '../scope/hash';
import { stripInvisible } from '../scope/invisible';

export const SURVEY_LIMITS = {
  findings: 20,
  photosPerFinding: 4,
  /** Every photo uploaded to one survey's job, used or not. */
  photosPerSurvey: 60,
  ownerLine: 300,
  title: 120,
  observation: 900,
  assessment: 900,
  notes: 10,
  note: 300,
  conclusionLine: 600,
  opinion: 2400,
  remedial: 160,
  preparedBy: 80,
  address: 300,
} as const;

export type SurveyEngine = 'ai' | 'basic';

const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const BAD = 'That has characters we cannot save';
const line = (max: number) => z.string().max(max).refine((v) => !CONTROL.test(v), BAD);
const para = (max: number) => z.string().max(max).refine((v) => !CONTROL_KEEP_NEWLINE.test(v), BAD);

/** Photo ids are uuids made by the server (demo mode: demo-photo-...). */
export const PHOTO_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|demo-photo-[a-z0-9-]{6,48})$/;
export const FINDING_ID = /^f-[a-z0-9]{6,24}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const findingSchema = z.object({
  id: z.string().regex(FINDING_ID),
  photoIds: z.array(z.string().regex(PHOTO_ID)).max(SURVEY_LIMITS.photosPerFinding),
  ownerLine: line(SURVEY_LIMITS.ownerLine),
  title: line(SURVEY_LIMITS.title),
  observation: para(SURVEY_LIMITS.observation),
  assessment: para(SURVEY_LIMITS.assessment),
  corrections: z.array(line(SURVEY_LIMITS.note)).max(SURVEY_LIMITS.notes),
  uncertain: z.array(line(SURVEY_LIMITS.note)).max(SURVEY_LIMITS.notes),
  engine: z.enum(['ai', 'basic']).nullable(),
  approvedAt: z.string().max(40).nullable(),
  approvalHash: z.string().max(80).nullable(),
});
export type Finding = z.infer<typeof findingSchema>;

export const surveyFormSchema = z.object({
  schema: z.literal(1),
  propertyAddress: para(SURVEY_LIMITS.address),
  surveyDate: z.string().max(10).refine((v) => v === '' || DATE.test(v), 'Enter the date as a date'),
  preparedBy: line(SURVEY_LIMITS.preparedBy),
  coverPhotoId: z.string().max(60).refine((v) => v === '' || PHOTO_ID.test(v), 'Choose a photo from this report'),
  findings: z.array(findingSchema).max(SURVEY_LIMITS.findings),
  conclusionLine: para(SURVEY_LIMITS.conclusionLine),
  opinion: para(SURVEY_LIMITS.opinion),
  opinionEngine: z.enum(['ai', 'basic']).nullable(),
  opinionApprovedAt: z.string().max(40).nullable(),
  opinionHash: z.string().max(80).nullable(),
  remedial: line(SURVEY_LIMITS.remedial),
  signName: line(SURVEY_LIMITS.preparedBy),
  signDate: z.string().max(10).refine((v) => v === '' || DATE.test(v), 'Enter the date as a date'),
});
export type SurveyFormValues = z.infer<typeof surveyFormSchema>;

export function emptySurvey(d: { surveyDate: string; preparedBy: string; propertyAddress?: string }): SurveyFormValues {
  return {
    schema: 1,
    propertyAddress: d.propertyAddress ?? '',
    surveyDate: d.surveyDate,
    preparedBy: d.preparedBy,
    coverPhotoId: '',
    findings: [],
    conclusionLine: '',
    opinion: '',
    opinionEngine: null,
    opinionApprovedAt: null,
    opinionHash: null,
    remedial: '',
    signName: d.preparedBy,
    signDate: d.surveyDate,
  };
}

/** A finding id that is unique within a report. Only used to tell findings apart; it never reaches the document. */
export function newFindingId(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)];
  return `f-${s}`;
}

export function emptyFinding(id: string = newFindingId()): Finding {
  return { id, photoIds: [], ownerLine: '', title: '', observation: '', assessment: '', corrections: [], uncertain: [], engine: null, approvedAt: null, approvalHash: null };
}

// ------------------------------------------------------------------ tidy text

/** One line: invisible characters and control characters out, spaces collapsed. Words are never changed. */
export function tidyLine(raw: string): string {
  return stripInvisible(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A paragraph box: as line, but blank lines between paragraphs are kept (at most one). */
export function tidyPara(raw: string): string {
  return stripInvisible(raw)
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Paragraphs of a paragraph box, for the document. */
export const paragraphs = (raw: string): string[] => tidyPara(raw).split('\n\n').filter(Boolean);

// ------------------------------------------------------------------ fingerprints

/** What the customer reads of one finding, and which photos it shows, in order. */
export function findingHash(f: Pick<Finding, 'id' | 'photoIds' | 'title' | 'observation' | 'assessment'>): string {
  return `h${sha256Hex(JSON.stringify({ v: 1, id: f.id, photos: f.photoIds, title: tidyLine(f.title), observation: tidyPara(f.observation), assessment: tidyPara(f.assessment) }))}`;
}

/** The professional opinion and the remedial works line, both signed by the person preparing the report. */
export function opinionHash(v: Pick<SurveyFormValues, 'opinion' | 'remedial' | 'signName'>): string {
  return `h${sha256Hex(JSON.stringify({ v: 1, opinion: tidyPara(v.opinion), remedial: tidyLine(v.remedial), signer: tidyLine(v.signName) }))}`;
}

const realTime = (t: string | null): boolean => typeof t === 'string' && !Number.isNaN(Date.parse(t));

export function isFindingApproved(f: Finding): boolean {
  return realTime(f.approvedAt) && f.approvalHash !== null && f.approvalHash === findingHash(f);
}

export function isOpinionApproved(v: SurveyFormValues): boolean {
  return realTime(v.opinionApprovedAt) && v.opinionHash !== null && v.opinionHash === opinionHash(v);
}

export const withoutFindingApproval = (f: Finding): Finding => ({ ...f, approvedAt: null, approvalHash: null });

/** Drops approvals that no longer match their content (the browser does this too, so screen and server agree). */
export function settleApprovals(v: SurveyFormValues): SurveyFormValues {
  return {
    ...v,
    findings: v.findings.map((f) => (f.approvedAt || f.approvalHash ? (isFindingApproved(f) ? f : withoutFindingApproval(f)) : f)),
    ...(v.opinionApprovedAt || v.opinionHash ? (isOpinionApproved(v) ? {} : { opinionApprovedAt: null, opinionHash: null }) : {}),
  };
}

/**
 * What a save from the browser may keep. Approval fields are never taken from the browser: a finding keeps its
 * approval only when the stored finding with the same id carries the same fingerprint AND the incoming content still
 * hashes to it. The same for the opinion. Only the server's approve step writes approvals (trustApproval).
 */
export function sanitiseIncomingSurvey(incoming: SurveyFormValues, stored: SurveyFormValues | null): SurveyFormValues {
  const storedById = new Map((stored?.findings ?? []).map((f) => [f.id, f]));
  const findings = incoming.findings.map((f) => {
    const s = storedById.get(f.id);
    if (s && s.approvalHash && s.approvedAt && findingHash(f) === s.approvalHash) return { ...f, approvedAt: s.approvedAt, approvalHash: s.approvalHash };
    return withoutFindingApproval(f);
  });
  const keepOpinion = stored && stored.opinionHash && stored.opinionApprovedAt && opinionHash(incoming) === stored.opinionHash;
  return {
    ...incoming,
    findings,
    opinionApprovedAt: keepOpinion ? stored.opinionApprovedAt : null,
    opinionHash: keepOpinion ? stored.opinionHash : null,
  };
}

// ------------------------------------------------------------------ checks

/** "Photo 3.2": finding 3, second photo. Numbering follows the order of the findings and photos, always. */
export const photoLabel = (finding: number, n: number): string => `Photo ${finding}.${n}`;

export function photoCount(v: Pick<SurveyFormValues, 'findings'>): number {
  return v.findings.reduce((s, f) => s + f.photoIds.length, 0);
}

/** Field errors while typing (shown next to the boxes). */
export function surveyErrors(v: SurveyFormValues): Record<string, string> {
  const e: Record<string, string> = {};
  const L = SURVEY_LIMITS;
  if (tidyPara(v.propertyAddress).length > L.address) e.propertyAddress = `Keep the address to ${L.address} characters or fewer`;
  if (v.findings.length > L.findings) e.findings = `A report can have up to ${L.findings} findings`;
  const seen = new Set<string>();
  v.findings.forEach((f, i) => {
    if (seen.has(f.id)) e[`findings.${i}`] = 'This finding appears twice';
    seen.add(f.id);
    if (f.photoIds.length > L.photosPerFinding) e[`findings.${i}.photos`] = `Up to ${L.photosPerFinding} photos for each finding`;
    if (new Set(f.photoIds).size !== f.photoIds.length) e[`findings.${i}.photos`] = 'The same photo is in this finding twice';
  });
  const used = v.findings.flatMap((f) => f.photoIds);
  if (new Set(used).size !== used.length) e.findings = 'The same photo is used in two findings. Each photo belongs to one finding.';
  if (v.coverPhotoId && !used.includes(v.coverPhotoId)) e.coverPhotoId = 'The cover photo must be one of the photos in this report';
  return e;
}

/**
 * Everything that stops the report being finalised, in plain words, in the order the owner meets them. Empty means
 * ready (the server still checks the approvals against the audit trail).
 */
export function surveyProblems(v: SurveyFormValues): string[] {
  const out: string[] = [];
  if (!tidyPara(v.propertyAddress)) out.push('The report has no property address.');
  if (!DATE.test(v.surveyDate)) out.push('The report has no survey date.');
  if (!tidyLine(v.preparedBy)) out.push('Say who prepared the report.');
  if (v.findings.length === 0) out.push('Add at least one finding.');
  v.findings.forEach((f, i) => {
    const n = i + 1;
    if (f.photoIds.length === 0) out.push(`Finding ${n} has no photo. Add one to four photos.`);
    if (!tidyLine(f.title)) out.push(`Finding ${n} has no title.`);
    if (!tidyPara(f.observation)) out.push(`Finding ${n} has no observation.`);
    if (!tidyPara(f.assessment)) out.push(`Finding ${n} has no professional assessment.`);
    if (tidyLine(f.title) && tidyPara(f.observation) && tidyPara(f.assessment) && f.photoIds.length > 0 && !isFindingApproved(f)) out.push(`Finding ${n} has not been approved.`);
  });
  if (!tidyPara(v.opinion)) out.push('Write your professional opinion.');
  else if (!isOpinionApproved(v)) out.push('Your professional opinion has not been approved.');
  if (!tidyLine(v.signName)) out.push('Type your name to sign the report.');
  if (!DATE.test(v.signDate)) out.push('Add the date you sign the report.');
  for (const msg of Object.values(surveyErrors(v))) out.push(msg.endsWith('.') ? msg : `${msg}.`);
  return [...new Set(out)];
}

// ------------------------------------------------------------------ the deterministic draft

/**
 * The draft used when no AI is set up (or the AI is not used): the owner's own line goes into the observation word
 * for word, the title is the line too when it is short enough to be one, and the assessment is left empty for the
 * owner to write. It never adds a word.
 */
export function basicFindingDraft(ownerLine: string): Pick<Finding, 'title' | 'observation' | 'assessment' | 'corrections' | 'uncertain' | 'engine'> {
  const said = tidyLine(ownerLine);
  return {
    title: said.length <= 80 ? said : '',
    observation: said,
    assessment: '',
    corrections: [],
    uncertain: [],
    engine: 'basic',
  };
}
