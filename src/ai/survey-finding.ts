import { aiConfig } from './client';
import { anthropicVisionClient, type VisionClient } from './vision-client';
import { findingProblems, opinionProblems } from './finding-check';
import { SURVEY_FINDING_PROMPT_VERSION, SURVEY_FINDING_RETRY_NOTE, SURVEY_FINDING_SYSTEM, buildSurveyFindingText } from './prompts/survey-finding.v1';
import { SURVEY_OPINION_PROMPT_VERSION, SURVEY_OPINION_RETRY_NOTE, SURVEY_OPINION_SYSTEM, buildSurveyOpinionText } from './prompts/survey-opinion.v1';
import { extractJsonObject } from './schemas';
import { z } from 'zod';
import { stripInvisible } from '../lib/scope/invisible';
import { basicFindingDraft, SURVEY_LIMITS, tidyLine, tidyPara, type SurveyEngine } from '../lib/survey/model';

export { SURVEY_FINDING_PROMPT_VERSION, SURVEY_OPINION_PROMPT_VERSION };

/**
 * The survey's AI seam.
 *
 *   draftFinding({ photos, ownerLine }) -> { title, observation, assessment, corrections[], uncertain[] }
 *   draftOpinion({ findings, ownerLine }) -> { opinion, uncertain[] }
 *
 * With ANTHROPIC_API_KEY set, the model drafts (photos are sent only then, server side, never logged or kept).
 * Whatever comes back is checked (shape, and src/ai/finding-check.ts); anything that fails falls back to the
 * deterministic draft: the owner's own words, nothing added. Without the key, the deterministic draft is used.
 * The owner edits and approves every finding and the opinion; nothing here is ever final.
 */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const t = (max: number) => z.string().trim().max(max).refine((v) => !CONTROL.test(v), 'control characters');
const findingReply = z.object({
  title: t(SURVEY_LIMITS.title).pipe(z.string().min(1)),
  observation: t(SURVEY_LIMITS.observation).pipe(z.string().min(1)),
  assessment: t(SURVEY_LIMITS.assessment),
  corrections: z.array(t(SURVEY_LIMITS.note)).max(SURVEY_LIMITS.notes),
  uncertain: z.array(t(SURVEY_LIMITS.note)).max(SURVEY_LIMITS.notes),
});
const opinionReply = z.object({ opinion: t(SURVEY_LIMITS.opinion).pipe(z.string().min(1)), uncertain: z.array(t(SURVEY_LIMITS.note)).max(SURVEY_LIMITS.notes) });

const INJECTION = /\b(?:ignore|disregard|forget|override)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all|any|your)\b[^.]{0,30}\b(?:instructions?|prompts?|rules?)\b|\bsystem\s+prompt\b|\byou\s+are\s+now\b|\bnew\s+instructions?\b|\bas\s+an\s+ai\b/i;
const MIN_ATTEMPT_MS = 4000;

export const NOTICE_NO_AI = null;
export const NOTICE_INSTRUCTION = 'Your line reads like an instruction to the AI assistant, so the AI was not used. Your words went into the observation as you wrote them.';
export const NOTICE_UNREACHABLE = 'The AI assistant could not be reached, so your words went into the observation as you wrote them. Add the title and your assessment.';
export const NOTICE_REJECTED = 'The AI draft added something you did not say, so it was not used. Your words went into the observation as you wrote them.';
export const NOTICE_LIMITED = 'You have used the AI assistant a lot in the last few minutes, so your words went into the observation as you wrote them. Try the AI again in a little while.';

export interface AiUsage {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  valid: boolean;
}
export interface FindingDraft {
  title: string;
  observation: string;
  assessment: string;
  corrections: string[];
  uncertain: string[];
  engine: SurveyEngine;
  notice: string | null;
  usage: AiUsage | null;
}
export interface SurveyAiDeps {
  /** Left out: from the environment. null forces the deterministic draft. */
  client?: VisionClient | null;
  model?: string;
  budgetMs?: number;
  clock?: () => number;
  /** Asked once, right before the first model call. False: over the person's limit. */
  permit?: () => boolean;
}

function resolve(deps: SurveyAiDeps): { client: VisionClient; model: string } | null {
  if (deps.client === null) return null;
  if (deps.client) return { client: deps.client, model: deps.model ?? 'stub' };
  const cfg = aiConfig();
  return cfg ? { client: anthropicVisionClient(cfg), model: cfg.model } : null;
}

const parse = <T>(schema: z.ZodType<T>, text: string): T | null => {
  try {
    const r = schema.safeParse(extractJsonObject(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
};

export async function draftFinding(input: { photos: Buffer[]; ownerLine: string }, deps: SurveyAiDeps = {}): Promise<FindingDraft> {
  const line = tidyLine(input.ownerLine);
  const basic: FindingDraft = { ...basicFindingDraft(line), engine: 'basic', notice: null, usage: null };
  if (line === '') return basic;
  const ai = resolve(deps);
  if (!ai || input.photos.length === 0) return basic;
  if (INJECTION.test(stripInvisible(line).normalize('NFKC'))) return { ...basic, notice: NOTICE_INSTRUCTION };
  if (deps.permit && !deps.permit()) return { ...basic, notice: NOTICE_LIMITED };

  const clock = deps.clock ?? Date.now;
  const started = clock();
  const budget = deps.budgetMs ?? 30_000;
  let tin = 0;
  let tout = 0;
  let reachable = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budget - (clock() - started);
    if (attempt > 0 && left < MIN_ATTEMPT_MS) break;
    let text: string;
    try {
      const body = buildSurveyFindingText(line, input.photos.length);
      const reply = await ai.client.complete({ system: SURVEY_FINDING_SYSTEM, text: attempt === 0 ? body : `${body}\n\n${SURVEY_FINDING_RETRY_NOTE}`, images: input.photos, maxTokens: 1500, signal: AbortSignal.timeout(Math.max(1, left)) });
      text = reply.text;
      tin += reply.inputTokens ?? 0;
      tout += reply.outputTokens ?? 0;
    } catch {
      reachable = false;
      break;
    }
    const d = parse(findingReply, text);
    if (!d) continue;
    if (findingProblems(line, d).length > 0) continue;
    return {
      title: tidyLine(d.title),
      observation: tidyPara(d.observation),
      assessment: tidyPara(d.assessment),
      corrections: d.corrections.map(tidyLine).filter(Boolean),
      uncertain: d.uncertain.map(tidyLine).filter(Boolean),
      engine: 'ai',
      notice: null,
      usage: { model: ai.model, inputTokens: tin || null, outputTokens: tout || null, valid: true },
    };
  }
  return { ...basic, notice: reachable ? NOTICE_REJECTED : NOTICE_UNREACHABLE, usage: reachable ? { model: ai.model, inputTokens: tin || null, outputTokens: tout || null, valid: false } : null };
}

export interface OpinionDraft {
  opinion: string;
  uncertain: string[];
  engine: SurveyEngine;
  notice: string | null;
  usage: AiUsage | null;
}

const FIRST_PERSON = /\b(?:I|my|me)\b/;
const OPINION_FRAME = 'Based on the inspection carried out and the defects recorded in this report, it is my professional opinion that';

/** Without the AI, the owner's own line is the opinion, as written. With it, the draft is checked strictly. */
export async function draftOpinion(input: { findings: { title: string; observation: string; assessment: string }[]; ownerLine: string }, deps: SurveyAiDeps = {}): Promise<OpinionDraft> {
  const line = tidyPara(input.ownerLine);
  const basic: OpinionDraft = { opinion: line, uncertain: [], engine: 'basic', notice: null, usage: null };
  if (line === '') return basic;
  const ai = resolve(deps);
  if (!ai) return basic;
  const texts = [line, ...input.findings.flatMap((f) => [f.title, f.observation, f.assessment])];
  if (texts.some((x) => INJECTION.test(stripInvisible(x).normalize('NFKC')))) return { ...basic, notice: 'Something in the report reads like an instruction to the AI assistant, so the AI was not used. Your line is the opinion as you wrote it.' };
  if (deps.permit && !deps.permit()) return { ...basic, notice: 'You have used the AI assistant a lot in the last few minutes, so your line is the opinion as you wrote it.' };
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const budget = deps.budgetMs ?? 25_000;
  let tin = 0;
  let tout = 0;
  let reachable = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budget - (clock() - started);
    if (attempt > 0 && left < MIN_ATTEMPT_MS) break;
    let text: string;
    try {
      const body = buildSurveyOpinionText(input.findings, line);
      const reply = await ai.client.complete({ system: SURVEY_OPINION_SYSTEM, text: attempt === 0 ? body : `${body}\n\n${SURVEY_OPINION_RETRY_NOTE}`, images: [], maxTokens: 1500, signal: AbortSignal.timeout(Math.max(1, left)) });
      text = reply.text;
      tin += reply.inputTokens ?? 0;
      tout += reply.outputTokens ?? 0;
    } catch {
      reachable = false;
      break;
    }
    const d = parse(opinionReply, text);
    if (!d || !FIRST_PERSON.test(d.opinion)) continue;
    // The wording of the form itself ("it is my professional opinion") is not an invention.
    if (opinionProblems([...texts, OPINION_FRAME], d.opinion, d.uncertain).length > 0) continue;
    return { opinion: tidyPara(d.opinion), uncertain: d.uncertain.map(tidyLine).filter(Boolean), engine: 'ai', notice: null, usage: { model: ai.model, inputTokens: tin || null, outputTokens: tout || null, valid: true } };
  }
  return { ...basic, notice: reachable ? 'The AI draft added something that is not in your findings, so it was not used. Your line is the opinion as you wrote it.' : 'The AI assistant could not be reached, so your line is the opinion as you wrote it.', usage: reachable ? { model: ai.model, inputTokens: tin || null, outputTokens: tout || null, valid: false } : null };
}
