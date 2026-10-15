import { describe, expect, it } from 'vitest';
import {
  basicFindingDraft,
  emptyFinding,
  emptySurvey,
  findingHash,
  isFindingApproved,
  isOpinionApproved,
  newFindingId,
  opinionHash,
  paragraphs,
  photoLabel,
  sanitiseIncomingSurvey,
  settleApprovals,
  surveyErrors,
  surveyFormSchema,
  surveyProblems,
  tidyPara,
  type Finding,
  type SurveyFormValues,
} from '../../src/lib/survey/model';
import { FJC_SURVEY_WORDING, FJC_WORDING, tenantWordingSchema } from '../../src/db/wording';
import { fillBusiness, mapSurvey, quoteLinkLine, type SurveyFacts } from '../../src/lib/survey/map';
import { surveyEditStep, surveySummary } from '../../src/lib/survey/page';
import { deriveJobStage, surveyedOnlyProgress } from '../../src/lib/job-stage';
import { photoLayout } from '../../src/templates/survey';
import { fakeTenant } from '../fixtures/fake';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

function finding(over: Partial<Finding> = {}): Finding {
  return { ...emptyFinding('f-aaaaaa0001'), photoIds: [P1], ownerLine: 'gutter blocked', title: 'Gutter blocked', observation: 'The gutter is blocked.', assessment: 'In my assessment it needs clearing.', ...over };
}
function survey(over: Partial<SurveyFormValues> = {}): SurveyFormValues {
  return { ...emptySurvey({ surveyDate: '2026-10-14', preparedBy: 'Jane Demo', propertyAddress: '123 Bromley Road, BR1 1AA' }), findings: [finding()], opinion: 'It is my professional opinion that it needs work.', ...over };
}
function approved(v: SurveyFormValues): SurveyFormValues {
  return { ...v, findings: v.findings.map((f) => ({ ...f, approvedAt: '2026-10-14T10:00:00.000Z', approvalHash: findingHash(f) })), opinionApprovedAt: '2026-10-14T10:00:00.000Z', opinionHash: opinionHash(v) };
}

describe('survey form model', () => {
  it('the deterministic draft puts the owner line into the observation word for word, adds nothing, and leaves the assessment empty', () => {
    for (const line of ['fascias overhang the gutter', 'Felt patched in a different material.', '  two   spaces  ', 'x'.repeat(200)]) {
      const d = basicFindingDraft(line);
      expect(d.observation).toBe(line.replace(/\s+/g, ' ').trim());
      expect(d.assessment).toBe('');
      expect(d.corrections).toEqual([]);
      expect(d.uncertain).toEqual([]);
      expect(d.engine).toBe('basic');
      if (d.title) expect(d.title).toBe(d.observation);
    }
    expect(basicFindingDraft('x'.repeat(200)).title).toBe('');
  });

  it('fingerprints change with any word or photo, and with photo order, but not with spacing', () => {
    const f = finding();
    const h = findingHash(f);
    expect(findingHash({ ...f, title: 'Gutter blocked ' })).toBe(h);
    expect(findingHash({ ...f, observation: 'The gutter is  blocked.' })).toBe(h);
    expect(findingHash({ ...f, assessment: 'In my assessment it needs clearing soon.' })).not.toBe(h);
    expect(findingHash({ ...f, photoIds: [P1, P2] })).not.toBe(h);
    expect(findingHash({ ...f, photoIds: [P2, P1] })).not.toBe(findingHash({ ...f, photoIds: [P1, P2] }));
    expect(findingHash({ ...f, ownerLine: 'something else' } as Finding)).toBe(h);
    const v = survey();
    expect(opinionHash({ ...v, remedial: 'To be quoted' })).not.toBe(opinionHash(v));
    expect(opinionHash({ ...v, signName: 'Someone Else' })).not.toBe(opinionHash(v));
    expect(opinionHash({ ...v, signDate: '2026-10-15' })).not.toBe(opinionHash(v));
    expect(opinionHash({ ...v, preparedBy: 'Someone Else' })).not.toBe(opinionHash(v));
  });

  it('approval holds only while the content matches; settleApprovals drops the rest', () => {
    const v = approved(survey());
    expect(isFindingApproved(v.findings[0])).toBe(true);
    expect(isOpinionApproved(v)).toBe(true);
    expect(settleApprovals({ ...v, signDate: '2026-10-20' }).opinionHash).toBeNull();
    const edited = settleApprovals({ ...v, findings: [{ ...v.findings[0], title: 'Changed' }], opinion: 'Changed.' });
    expect(edited.findings[0].approvalHash).toBeNull();
    expect(edited.opinionHash).toBeNull();
    expect(isFindingApproved({ ...v.findings[0], approvedAt: 'not a time' })).toBe(false);
  });

  it('a save never takes an approval from the browser (property: 300 crafted saves)', () => {
    const stored = survey();
    for (let i = 0; i < 300; i++) {
      const incoming = approved(survey({ findings: [finding({ assessment: `In my assessment ${i}.` })] }));
      const out = sanitiseIncomingSurvey(incoming, stored);
      expect(out.findings[0].approvalHash).toBeNull();
      expect(out.findings[0].approvedAt).toBeNull();
      expect(out.opinionHash).toBeNull();
    }
    // With a stored approval of the same content, it is kept (the server's time, not the browser's).
    const s2 = approved(survey());
    const kept = sanitiseIncomingSurvey({ ...s2, findings: [{ ...s2.findings[0], approvedAt: '2030-01-01T00:00:00.000Z' }], opinionApprovedAt: '2030-01-01T00:00:00.000Z' }, s2);
    expect(kept.findings[0].approvedAt).toBe(s2.findings[0].approvedAt);
    expect(kept.opinionApprovedAt).toBe(s2.opinionApprovedAt);
    // Same id, different content: dropped.
    const changed = sanitiseIncomingSurvey({ ...s2, findings: [{ ...s2.findings[0], observation: 'Other.' }] }, s2);
    expect(changed.findings[0].approvalHash).toBeNull();
  });

  it('problems list everything that blocks finalising, in plain words', () => {
    expect(surveyProblems(approved(survey()))).toEqual([]);
    const p = surveyProblems(survey({ propertyAddress: '', findings: [finding({ photoIds: [], assessment: '' }), finding({ id: 'f-aaaaaa0002', photoIds: [P2] })], opinion: '' }));
    expect(p).toContain('The report has no property address.');
    expect(p).toContain('Finding 1 has no photo. Add one to four photos.');
    expect(p).toContain('Finding 1 has no professional assessment.');
    expect(p).toContain('Finding 2 has not been approved.');
    expect(p).toContain('Write your professional opinion.');
    expect(surveyProblems(survey({ findings: [] }))).toContain('Add at least one finding.');
  });

  it('field errors: photo reuse, cover not in the report, duplicates', () => {
    expect(surveyErrors(survey({ findings: [finding(), finding({ id: 'f-aaaaaa0002' })] })).findings).toMatch(/two findings/);
    expect(surveyErrors(survey({ coverPhotoId: P2 })).coverPhotoId).toBeDefined();
    expect(surveyErrors(survey({ findings: [finding({ photoIds: [P1, P1] })] }))['findings.0.photos']).toBeDefined();
  });

  it('the schema refuses control characters, too many photos and bad ids', () => {
    expect(surveyFormSchema.safeParse(survey()).success).toBe(true);
    expect(surveyFormSchema.safeParse(survey({ findings: [finding({ title: 'a\u0007b' })] })).success).toBe(false);
    expect(surveyFormSchema.safeParse(survey({ findings: [finding({ photoIds: [P1, P2, P1, P2, P1] })] })).success).toBe(false);
    expect(surveyFormSchema.safeParse(survey({ findings: [finding({ photoIds: ['../../etc'] })] })).success).toBe(false);
    expect(surveyFormSchema.safeParse(survey({ coverPhotoId: 'x' })).success).toBe(false);
    for (let i = 0; i < 100; i++) expect(newFindingId()).toMatch(/^f-[a-z0-9]{10}$/);
  });

  it('paragraphs keep blank-line breaks only', () => {
    expect(paragraphs('One.\nstill one.\n\n\n\nTwo.')).toEqual(['One. still one.', 'Two.']);
    expect(tidyPara('a​b')).toBe('ab');
    expect(photoLabel(3, 2)).toBe('Photo 3.2');
  });
});

describe('survey mapping', () => {
  const facts = (over: Partial<SurveyFacts> = {}): SurveyFacts => ({
    number: 'SR-DEMO-4001',
    jobReference: 'DEMO-4001',
    customerName: 'Mr John Smith',
    form: approved(survey()),
    photos: { [P1]: { id: P1, path: `t/c/j/${P1}.jpg`, sha256: 'a'.repeat(64), width: 2000, height: 1500 } },
    ...over,
  });

  it('maps an approved survey with the business wording, the business name filled in, and photo references (no bytes)', () => {
    const r = mapSurvey(facts(), fakeTenant, FJC_SURVEY_WORDING);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.title).toBe('Roof Defect Survey Report');
    expect(r.input.intro.join(' ')).toContain(`prepared by ${fakeTenant.name}`);
    expect(r.input.intro.join(' ')).not.toContain('{business}');
    expect(r.input.findings[0].photos[0]).toMatchObject({ id: P1, sha256: 'a'.repeat(64) });
    expect(r.input.dateLabel).toBe('14 October 2026');
    expect(r.input.preparedBy).toBe(`Jane Demo, ${fakeTenant.name}`);
    expect(r.input.signRole).toBe(fakeTenant.name);
    expect(r.input.coverSub).toBeNull();
    expect(r.input.remedial).toBeNull();
    expect(JSON.stringify(r.input)).not.toMatch(/base64/);
  });

  it('blocks with plain messages: no wording, an unapproved finding, a photo no longer stored', () => {
    const noWording = mapSurvey(facts(), fakeTenant, null);
    expect(noWording.ok).toBe(false);
    if (!noWording.ok) expect(noWording.missing[0]).toMatch(/survey report wording is not set up/);
    const unapproved = mapSurvey(facts({ form: survey() }), fakeTenant, FJC_SURVEY_WORDING);
    if (!unapproved.ok) expect(unapproved.missing).toContain('Finding 1 has not been approved.');
    const gone = mapSurvey(facts({ photos: {} }), fakeTenant, FJC_SURVEY_WORDING);
    if (!gone.ok) expect(gone.missing.join(' ')).toMatch(/photo in finding 1 is no longer stored/);
    expect(mapSurvey(facts({ form: null }), fakeTenant, FJC_SURVEY_WORDING).ok).toBe(false);
  });

  it('the quote line comes from the business wording, with the report number', () => {
    expect(quoteLinkLine(FJC_SURVEY_WORDING, 'SR-FJC1002')).toBe('Read alongside survey report SR-FJC1002');
    expect(quoteLinkLine({ ...FJC_SURVEY_WORDING, quoteLink: undefined }, 'SR-1')).toBeNull();
    expect(quoteLinkLine(null, 'SR-1')).toBeNull();
    expect(fillBusiness('{business} and {business}', 'Demo Ltd')).toBe('Demo Ltd and Demo Ltd');
  });

  it('FJC survey wording is valid tenant data and holds no customer details', () => {
    expect(tenantWordingSchema.parse(FJC_WORDING).survey).toEqual(FJC_SURVEY_WORDING);
    const text = JSON.stringify(FJC_SURVEY_WORDING);
    expect(text).not.toMatch(/\d/);
    expect(text).not.toMatch(/@|Elm Park|Hornchurch|Avenue/i);
  });

  it('summary and edit step', () => {
    expect(surveyEditStep(survey({ propertyAddress: '' }))).toBe('details');
    expect(surveyEditStep(survey())).toBe('findings');
    expect(surveyEditStep(approved(survey()))).toBe('conclusion');
    const s = surveySummary(survey(), 'Mr John Smith', 'SR-1');
    expect(s.find((x) => x.title === 'Findings')?.rows.find((r) => r.label === 'Approved')?.value).toBe('0 of 1');
  });
});

describe('job stage: Surveyed before Quoted', () => {
  it('a final survey puts Surveyed first; a draft one does not', () => {
    const inst = [{ index: 1, label: 'Deposit', grossPence: 100 }, { index: 2, label: 'Balance', grossPence: 200 }];
    const withSurvey = deriveJobStage({ kind: 'deposit' }, inst, [], [{ type: 'survey', instalment: null, status: 'final' }]);
    expect(withSurvey.steps.map((s) => s.key).slice(0, 2)).toEqual(['surveyed', 'quoted']);
    expect(withSurvey.currentIndex).toBe(1);
    expect(withSurvey.next?.type).toBe('deposit-invoice');
    const draft = deriveJobStage({ kind: 'deposit' }, inst, [], [{ type: 'survey', instalment: null, status: 'draft' }]);
    expect(draft.steps[0].key).toBe('quoted');
    const only = surveyedOnlyProgress();
    expect(only.steps.map((s) => s.label)).toEqual(['Surveyed', 'Quoted']);
    expect(only.next).toMatchObject({ type: 'quotation', action: 'create', label: 'Write the quote' });
  });
});

describe('photo layout (never cropped)', () => {
  const ph = (w: number, h: number) => ({ src: '', width: w, height: h });
  it('every photo keeps its shape and fits the room and the width (property)', () => {
    for (let i = 0; i < 400; i++) {
      const n = 1 + (i % 4);
      const photos = Array.from({ length: n }, () => ph(200 + Math.floor(Math.random() * 4000), 200 + Math.floor(Math.random() * 4000)));
      const room = 62 + Math.random() * 120;
      const l = photoLayout(photos, room);
      expect(l.heightMm).toBeLessThanOrEqual(room + 0.01);
      let k = 0;
      for (const r of l.rows) {
        const width = r.cells.reduce((s, c) => s + c.w, 0) + 3 * (r.cells.length - 1);
        expect(width).toBeLessThanOrEqual(178 + 0.01);
        for (const c of r.cells) {
          const p = photos[k++];
          expect(Math.abs(c.w / c.h - p.width / p.height)).toBeLessThan(0.05 * (p.width / p.height) + 0.02);
        }
      }
      expect(k).toBe(n);
      expect(l.rows.reduce((t, r) => t + r.cells.length, 0)).toBe(n);
    }
  });
});
