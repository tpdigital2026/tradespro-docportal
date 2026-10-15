import { aiConfig, anthropicClient, type ModelClient } from './client';
import { findInventions } from './invention';
import { buildScopeCopyUser, SCOPE_COPY_PROMPT_VERSION, SCOPE_COPY_RETRY_NOTE, SCOPE_COPY_SYSTEM } from './prompts/scope-copy.v1';
import { extractJsonObject, scopeCopyResponseSchema } from './schemas';
import { DEFAULT_SECTION_HEADING, groupItems, type CopySection, type ScopeEngine, type ScopeItem } from '../lib/scope/model';
import { tidyHeading, tidyItems, tidyStep } from '../lib/scope/tidy';

export { SCOPE_COPY_PROMPT_VERSION };

export interface GenerateInput {
  steps: readonly ScopeItem[];
  /** The label of the job type the owner chose, e.g. "Flat roof". Context only. */
  jobType: string;
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
  /** Said to the owner when the AI was expected but the basic tidy was used instead. */
  notice: string | null;
  /** Present when a model was called; ids and counts only, never text. */
  usage: AiUsage | null;
}
export interface GenerateDeps {
  /** Left out: chosen from the environment (ANTHROPIC_API_KEY on means the AI, off means the basic tidy). Null forces the basic tidy. */
  client?: ModelClient | null;
  model?: string;
  /** One budget for the whole job, retry included. Default 20 seconds. */
  budgetMs?: number;
  clock?: () => number;
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
  const basicResult: GenerateResult = { engine: 'fallback', ...basic, notice: null, usage: null };

  const ai = resolveClient(deps);
  if (!ai) return basicResult;
  if (groups.some((g) => [g.heading ?? '', ...g.steps].some((t) => INJECTION.test(t.normalize('NFKC'))))) return { ...basicResult, notice: NOTICE_INSTRUCTION };

  const sent = { jobType: input.jobType, groups: groups.map((g) => ({ heading: g.heading, steps: g.steps })) };
  const inputTexts = [input.jobType, DEFAULT_SECTION_HEADING, ...groups.flatMap((g) => [...(g.heading ? [g.heading] : []), ...g.steps])];
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
        system: SCOPE_COPY_SYSTEM,
        user: attempt === 0 ? buildScopeCopyUser(sent) : `${buildScopeCopyUser(sent)}\n\n${SCOPE_COPY_RETRY_NOTE}`,
        maxTokens: 4096,
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
    if (!parsed) continue;
    if (parsed.sections.length !== groups.length) continue;
    if (parsed.sections.some((s, i) => s.steps.length > groups[i]!.steps.length)) continue;
    const outputs = [...parsed.sections.flatMap((s) => [s.heading, ...s.steps]), ...parsed.corrections, ...parsed.uncertain];
    if (findInventions(inputTexts, outputs).length > 0) continue;
    const sections = parsed.sections.map((s) => ({ heading: tidyHeading(s.heading), steps: s.steps.map(tidyStep).filter(Boolean) }));
    if (sections.some((s) => s.heading === '' || s.steps.length === 0)) continue;
    return {
      engine: 'ai',
      sections,
      corrections: parsed.corrections,
      uncertain: parsed.uncertain,
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

function parseReply(text: string) {
  try {
    const r = scopeCopyResponseSchema.safeParse(extractJsonObject(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
