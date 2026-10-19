/**
 * What the draft and final pages show for a survey report: a plain summary, where Edit goes, and the AI notes for the
 * preview. Pure.
 */
import { longDate } from '../documents/map';
import type { SummarySection } from '../documents/summary';
import { isFindingApproved, isOpinionApproved, photoCount, tidyLine, tidyPara, type SurveyFormValues } from './model';

export const SURVEY_STEPS = ['details', 'findings', 'conclusion', 'check'] as const;
export type SurveyStep = (typeof SURVEY_STEPS)[number];

export const surveyEditHref = (documentId: string, step?: string) => `/documents/new?type=survey&draft=${encodeURIComponent(documentId)}${step ? `&step=${step}` : ''}`;

/** The first step with something left to do, for Edit. */
export function surveyEditStep(v: SurveyFormValues | null): string {
  if (!v) return 'details';
  if (!tidyPara(v.propertyAddress) || !v.surveyDate || !tidyLine(v.preparedBy)) return 'details';
  if (v.findings.length === 0 || v.findings.some((f) => !isFindingApproved(f))) return 'findings';
  return 'conclusion';
}

export function surveySummary(v: SurveyFormValues | null, customerName: string, number: string): SummarySection[] {
  if (!v) return [{ title: 'Report', rows: [{ label: 'Report', value: number }] }];
  const approved = v.findings.filter(isFindingApproved).length;
  const n = v.findings.length;
  return [
    {
      title: 'Report',
      rows: [
        { label: 'Report number', value: number },
        { label: 'Customer', value: customerName },
        { label: 'Property', value: tidyPara(v.propertyAddress).replace(/\n+/g, ', ') || 'Not entered yet', ...(tidyPara(v.propertyAddress) ? {} : { tone: 'warn' as const }) },
        { label: 'Survey date', value: longDate(v.surveyDate) || 'Not entered yet' },
        { label: 'Prepared by', value: tidyLine(v.preparedBy) || 'Not entered yet' },
      ],
    },
    {
      title: 'Findings',
      rows: [
        { label: 'Findings', value: n === 0 ? 'None yet' : String(n) },
        { label: 'Photographs', value: String(photoCount(v)) },
        { label: 'Approved', value: n === 0 ? 'Nothing to approve yet' : `${approved} of ${n}`, ...(approved < n || n === 0 ? { tone: 'warn' as const } : {}) },
      ],
    },
    {
      title: 'Conclusion',
      rows: [
        { label: 'Professional opinion', value: !tidyPara(v.opinion) ? 'Not written yet' : isOpinionApproved(v) ? 'Approved' : 'Written, not approved', ...(isOpinionApproved(v) ? {} : { tone: 'warn' as const }) },
        ...(tidyLine(v.remedial) ? [{ label: 'Remedial works', value: tidyLine(v.remedial) }] : []),
        { label: 'Signed', value: tidyLine(v.signName) ? `${tidyLine(v.signName)}, typed name` : 'Not signed yet' },
      ],
    },
  ];
}

/** The AI's notes for the preview: what it changed and what the owner should check, finding by finding. */
export function surveyNotes(v: SurveyFormValues | null): { corrections: string[]; uncertain: string[] } {
  if (!v) return { corrections: [], uncertain: [] };
  return {
    corrections: v.findings.flatMap((f, i) => f.corrections.map((c) => `Finding ${i + 1}: ${c}`)),
    uncertain: v.findings.flatMap((f, i) => f.uncertain.map((c) => `Finding ${i + 1}: ${c}`)),
  };
}
