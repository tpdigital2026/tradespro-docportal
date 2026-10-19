import { aiConfig, anthropicClient, type ModelClient } from './client';
import { stripInvisible } from '../lib/scope/invisible';
import { addedWork, missingFacts, newDigits } from './facts';
import { findInventions } from './invention';
import { buildScopeCopySystem, buildScopeCopyUser, SCOPE_COPY_PROMPT_VERSION, SCOPE_COPY_RETRY_NOTE } from './prompts/scope-copy.v2';
import { extractJsonObject, scopeCopyResponseSchemaV2, type ScopeCopyResponseV2 } from './schemas';
import { suggestionsFor, type ScopeSuggestion } from './suggestions';
import { scopeVoiceFor, type ScopeVoice } from './voices';
import { DEFAULT_SECTION_HEADING, groupItems, SCOPE_LIMITS, type CopySection, type ScopeEngine, type ScopeItem } from '../lib/scope/model';
import { tidyHeading, tidyItems, tidyStep } from '../lib/scope/tidy';

export { SCOPE_COPY_PROMPT_VERSION };
export type { ScopeSuggestion };

export interface GenerateInput {
  steps: readonly ScopeItem[];
  /** The label of the job type the owner chose, e.g. "Flat roof". Context only. */
  jobType: string;
  /** The business's usual steps for this job type (tenant data). Only used for "Things you could add" questions. */
  typicalSteps?: readonly string[];
  /** The business's voice (worked examples). Left out: the default voice. */
  voice?: ScopeVoice;
}
export interface AiUsage {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  valid: boolean;
}
export interface GenerateResult {
  engine: ScopeEngine;
  sections: CopySection[];
  corrections: string[];
  uncertain: string[];
  /** Questions about the business's usual steps that the owner did not mention. Never part of the wording. */
  suggestions: ScopeSuggestion[];
  /** Said to the owner when the AI was expected but the basic tidy was used instead. */
  notice: string | null;
  /** Present when a model was called; ids and counts only, never text. */
  usage: AiUsage | null;
  /** True when the model would have been called but `permit` said no (over the person's limit). */
  limited?: boolean;
}
export interface GenerateDeps {
  /** Left out: chosen from the environment (ANTHROPIC_API_KEY on means the AI, off means the basic tidy). Null forces the basic tidy. */
  client?: ModelClient | null;
  model?: string;
  /** One budget for the whole job, retry included. Default 20 seconds. */
  budgetMs?: number;
  clock?: () => number;
  /**
   * Asked once, right before the first model call and only if a model call is really about to happen (never for a
   * skipped step or an unconfigured AI). False means over the limit: the basic tidy is used and the result says so.
   */
  permit?: () => boolean;
  /** Told why an answer was thrown away (a short code, never any text). For the evaluation script and tests. */
  onReject?: (reason: string) => void;
}

export class NothingToTidyError extends Error {
  constructor() {
    super('There are no steps to tidy');
    this.name = 'NothingToTidyError';
  }
}

const NOTICE_INSTRUCTION = 'One of your steps reads like an instruction to the AI assistant, so the AI was not used. The basic tidy was used: it only fixes capital letters and full stops.';
/** Steps that try to talk to the assistant. Nothing is lost: the owner's words go through the basic tidy untouched. */
const INJECTION = /\b(?:ignore|disregard|forget|override)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all|any|your)\b[^.]{0,30}\b(?:instructions?|prompts?|rules?)\b|\bsystem\s+prompt\b|\byou\s+are\s+now\b|\bnew\s+instructions?\b|\bas\s+an\s+ai\b/i;
const MIN_ATTEMPT_MS = 4000;
const NOTICE_UNREACHABLE = 'The AI assistant could not be reached, so the basic tidy was used. It only fixes capital letters and full stops.';
const NOTICE_REJECTED = 'The AI wording changed more than it should, so it was not used. The basic tidy was used instead: it only fixes capital letters and full stops.';

function resolveClient(deps: GenerateDeps): { client: ModelClient; model: string } | null {
  if (deps.client === null) return null;
  if (deps.client) return { client: deps.client, model: deps.model ?? 'stub' };
  const cfg = aiConfig();
  return cfg ? { client: anthropicClient(cfg), model: cfg.model } : null;
}

/**
 * Tidies the owner's steps. With an AI key set up it asks the model; whatever comes back is checked (shape, same
 * groups, no figures, products, units, claims or names that the owner did not write) and anything that fails the
 * check is thrown away for the basic tidy. It never throws because of the model, and never logs the owner's text.
 */
export async function generateScopeCopy(input: GenerateInput, deps: GenerateDeps = {}): Promise<GenerateResult> {
  const groups = groupItems(input.steps).filter((g) => g.steps.length > 0);
  if (groups.length === 0) throw new NothingToTidyError();
  const basic = tidyItems(input.steps);
  const typicalSteps = (input.typicalSteps ?? []).map((t) => stripInvisible(t)).filter((t) => t.trim() !== '');
  const ownerTexts = [stripInvisible(input.jobType), ...groups.flatMap((g) => [...(g.heading ? [g.heading] : []), ...g.steps])];
  const voice = input.voice ?? scopeVoiceFor();
  const suggestions = suggestionsFor({ ownerTexts, jobType: stripInvisible(input.jobType), checklist: voice.checklist, typicalSteps });
  const basicResult: GenerateResult = { engine: 'fallback', ...basic, suggestions, notice: null, usage: null };

  const ai = resolveClient(deps);
  if (!ai) return basicResult;
  if (groups.some((g) => [g.heading ?? '', ...g.steps].some((t) => INJECTION.test(stripInvisible(t).normalize('NFKC'))))) return { ...basicResult, notice: NOTICE_INSTRUCTION };
  if (deps.permit && !deps.permit()) return { ...basicResult, limited: true };

  const sent = { jobType: stripInvisible(input.jobType), groups: groups.map((g) => ({ heading: g.heading, steps: g.steps })) };
  const system = buildScopeCopySystem(voice);
  const stepCount = groups.reduce((n, g) => n + g.steps.length, 0);
  const inputTexts = [stripInvisible(input.jobType), DEFAULT_SECTION_HEADING, ...groups.flatMap((g) => [...(g.heading ? [g.heading] : []), ...g.steps])];
  let tokensIn = 0;
  let tokensOut = 0;
  let reachable = true;

  const clock = deps.clock ?? Date.now;
  const started = clock();
  const budget = deps.budgetMs ?? 20_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budget - (clock() - started);
    if (attempt > 0 && left < MIN_ATTEMPT_MS) break;
    let text: string;
    try {
      const reply = await ai.client.complete({
        system,
        user: attempt === 0 ? buildScopeCopyUser(sent) : `${buildScopeCopyUser(sent)}\n\n${SCOPE_COPY_RETRY_NOTE}`,
        // Enough for every step said twice over plus the lists; a cap, not a cost.
        maxTokens: Math.min(4096, 1200 + stepCount * 120),
        signal: AbortSignal.timeout(Math.max(1, left)),
      });
      text = reply.text;
      tokensIn += reply.inputTokens ?? 0;
      tokensOut += reply.outputTokens ?? 0;
    } catch {
      reachable = false;
      break;
    }
    const parsed = parseReply(text);
    const why = parsed ? rejection(parsed, groups, inputTexts, voice.headings) : 'shape';
    if (why) {
      deps.onReject?.(why);
      continue;
    }
    if (!parsed) continue;
    const sections = parsed.sections.map((s) => ({ heading: tidyHeading(s.heading), steps: s.steps.map(tidyStep).filter(Boolean) }));
    if (sections.some((s) => s.heading === '' || s.steps.length === 0)) continue;
    return {
      engine: 'ai',
      sections,
      corrections: parsed.corrections,
      uncertain: parsed.uncertain,
      suggestions,
      notice: null,
      usage: { model: ai.model, inputTokens: tokensIn || null, outputTokens: tokensOut || null, valid: true },
    };
  }
  return {
    ...basicResult,
    notice: reachable ? NOTICE_REJECTED : NOTICE_UNREACHABLE,
    usage: reachable ? { model: ai.model, inputTokens: tokensIn || null, outputTokens: tokensOut || null, valid: false } : null,
  };
}

/** Most bullets a step may become: one action per bullet lets a step with two pieces of work become two. */
export const MAX_BULLETS_PER_STEP = 2;

/**
 * Every check the model's answer must pass, or it is thrown away. The invention check runs unchanged on the wording
 * (headings included) and the corrections. The "please check" questions are shown only to the owner, never to the
 * customer, so a question may name a material or part ("Did you mean scaffold?"); every other kind of invention
 * (figures, units, claims, standards, brands and names, other scripts, hidden characters) is refused there too.
 *
 * Groups: sections come in input order and cover every group. A group with a heading is exactly one section. A group
 * with no heading is one section headed "The works", or several, each with one of the business's own headings.
 * Each group's bullets may number at most twice its steps (one action per bullet).
 */
export function acceptable(
  parsed: ScopeCopyResponseV2,
  groups: readonly { heading: string | null; steps: string[] }[],
  inputTexts: readonly string[],
  ownHeadings: readonly string[] = [],
): boolean {
  return rejection(parsed, groups, inputTexts, ownHeadings) === null;
}

/** Why an answer fails the checks (a short code naming the check, and for inventions the kind), or null. */
export function rejection(
  parsed: ScopeCopyResponseV2,
  groups: readonly { heading: string | null; steps: string[] }[],
  inputTexts: readonly string[],
  ownHeadings: readonly string[] = [],
): string | null {
  const sections = parsed.sections;
  const hasGroups = sections.every((s) => s.group !== undefined);
  if (!hasGroups && sections.some((s) => s.group !== undefined)) return 'groups';
  const groupOf = (i: number) => (hasGroups ? sections[i]!.group! : i);
  if (!hasGroups && sections.length !== groups.length) return 'groups';
  const own = new Set(ownHeadings.map(headingKey));
  let next = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const mine: typeof sections = [];
    while (next < sections.length && groupOf(next) === gi) mine.push(sections[next++]!);
    if (mine.length === 0) return 'groups';
    const g = groups[gi]!;
    if (g.heading !== null && mine.length !== 1) return 'groups';
    if (g.heading === null && mine.length > 1 && mine.some((s) => !own.has(headingKey(s.heading)))) return 'heading';
    if (g.heading === null && mine.length === 1 && headingKey(mine[0]!.heading) !== headingKey(DEFAULT_SECTION_HEADING) && !own.has(headingKey(mine[0]!.heading))) return 'heading';
    const bullets = mine.reduce((n, s) => n + s.steps.length, 0);
    if (bullets > Math.min(SCOPE_LIMITS.stepsPerSection, g.steps.length * MAX_BULLETS_PER_STEP)) return 'too-many-bullets';
  }
  if (next !== sections.length) return 'groups';

  const wording = sections.flatMap((s) => [s.heading, ...s.steps]);
  const invented = findInventions(inputTexts, [...wording, ...parsed.corrections]);
  if (invented.length > 0) return `invention:${invented.map((x) => x.kind).join(',')}`;
  const askedBadly = findInventions(inputTexts, parsed.uncertain).filter((i) => i.kind !== 'product');
  if (askedBadly.length > 0) return `question-invention:${askedBadly.map((x) => x.kind).join(',')}`;
  const lost = missingFacts(groups.flatMap((g) => [...(g.heading ? [g.heading] : []), ...g.steps]), wording, parsed.corrections);
  if (lost.length > 0) return `lost-fact:${lost.map((x) => x.kind).join(',')}`;
  if (newDigits(inputTexts, wording).length > 0) return 'figure-form';
  if (addedWork(inputTexts, sections.flatMap((s) => s.steps)).length > 0) return 'added-work';
  return null;
}

const headingKey = (h: string) => h.toLocaleLowerCase('en-GB').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function parseReply(text: string): ScopeCopyResponseV2 | null {
  try {
    const r = scopeCopyResponseSchemaV2.safeParse(extractJsonObject(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
