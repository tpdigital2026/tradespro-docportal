/**
 * Evaluation of the scope wording against the REAL model. Not part of CI and never run by `npm test`.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/eval-scope-ai.ts --label r1 [--only 1,4,9]
 *
 * The key comes only from the environment (ANTHROPIC_API_KEY) and is never printed, logged or written; neither is
 * the system prompt. The model comes from ANTHROPIC_MODEL (default claude-sonnet-5-5). Every model call is counted
 * in out/eval-scope-ai/ledger.json and the script refuses to go past EVAL_MAX_CALLS (default 60) in total, across
 * runs. The inputs are made up. The report goes to out/eval-scope-ai/report-<label>.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aiConfig, anthropicClient, ModelError, type ModelClient } from '../src/ai/client';
import { missingFacts } from '../src/ai/facts';
import { findInventions } from '../src/ai/invention';
import { SCOPE_COPY_PROMPT_VERSION } from '../src/ai/prompts/scope-copy.v2';
import { generateScopeCopy, type GenerateResult } from '../src/ai/scope-copy';
import { typicalStepsFrom } from '../src/ai/suggestions';
import { FJC_SCOPE_VOICE_V2 } from '../src/ai/voices';
import { FJC_SCOPE_EXAMPLES } from '../src/lib/scope/fjc-examples';
import { DEFAULT_SECTION_HEADING, groupItems, type ScopeItem } from '../src/lib/scope/model';

interface Case {
  name: string;
  jobType: string;
  /** Job type key for the usual steps (tenant examples), if any. */
  key?: string;
  steps: string[];
}

/** "#" starts a heading. All made up. */
export const CASES: Case[] = [
  { name: "Owner's live test (dictated)", jobType: 'Tiled roof', key: 'tiled_roof', steps: ["set up sc yes we're going to set up the scaffolding and this will take 12 hours", 'take of exisitng roof'] },
  {
    name: 'Flat roof, typed with typos',
    jobType: 'Flat roof',
    key: 'flat_roof',
    steps: ['strip of old felt and dispose', 'inspect deck replace any rotton boards', '18mm osb deck', 'perferated tack down layer', '3mm underlay fully bonded', 'mineral cap sheet with drip edges', 'code 4 lead flashing to house wall'],
  },
  {
    name: 'Flat roof, long dictation',
    jobType: 'Flat roof',
    key: 'flat_roof',
    steps: [
      'okay so um first thing we need to get the skip delivered on the drive',
      'then strip off all the old felt and the decking back to the joists',
      "replace any joists that are rotten there's probably two or three",
      'new deck boards right across',
      'then the uh three layer felt system tack down layer underlay and cap sheet',
      'new drip edge trims round the front and sides',
      'lead flashing where it meets the house wall',
      'clear everything away at the end',
    ],
  },
  { name: 'Tiled roof, very short', jobType: 'Tiled roof', key: 'tiled_roof', steps: ['re roof', 'new tiles'] },
  {
    name: 'Tiled roof, typed with headings',
    jobType: 'Tiled roof',
    key: 'tiled_roof',
    steps: ['#site setup', 'scafold all round', 'skip', '#strip', 'strip tiles and battens', 'check rafters', '#new roof', 'breathable membrane', 'new battens', 'concrete interlocking tiles', 'dry ridge'],
  },
  {
    name: 'Fascias, dictated',
    jobType: 'Fascias and gutters',
    key: 'fascia',
    steps: ['take down the old wooden facias and soffits', 'fit new white upvc fascias and soffits all the way round', 'new black gutters and down pipes', 'take all the old stuff away'],
  },
  { name: 'Guttering, short typed', jobType: 'Guttering', steps: ['clear gutters', 'reseal joints on the back gutter', 'replace 2 brackets that are broken'] },
  {
    name: 'Chimney lead, dictated with a mishearing',
    jobType: 'Chimney',
    steps: ['remove the old led flashing round the chimney', 'new lead flashing and soakers code 4', 'rake out and repoint the chimney stack', 'new flanching on top', 'this will take 2 days'],
  },
  {
    name: 'Mixed job with headings',
    jobType: 'Other',
    key: 'other',
    steps: ['#main roof', 'replace 6 slipped tiles', 'rebed ridge tiles', '#flat roof over kitchen', 'new epdm rubber roof', 'new trims', '#gutters', 'clean all gutters out'],
  },
  {
    name: 'Fascia and gutter, noisy dictation',
    jobType: 'Fascias and gutters',
    key: 'fascia',
    steps: ["yeah so we'll put a tower up at the back", 'take off the gutter and the fascia board um the fascia board on the left side', 'new fascia board', 'put the gutter back yes put the gutter back on'],
  },
  {
    name: 'Flat roof with a name and typos',
    jobType: 'Flat roof',
    key: 'flat_roof',
    steps: ['site manager is Dave', 'protect the dinning room celling before we start', 'remove felt roof over the dinning room', 'new grp roof with trims'],
  },
  { name: 'Chimney removal', jobType: 'Chimney', steps: ['take down chimney stack to below roof line', 'tile over the hole to match', 'make good the felt and battens', 'take all rubble away in our truck'] },
];

// ---------------------------------------------------------------- call ledger (hard cap across runs)

const OUT = path.resolve('out/eval-scope-ai');
const LEDGER = path.join(OUT, 'ledger.json');
const MAX = Number(process.env.EVAL_MAX_CALLS ?? 60);
const readLedger = (): { calls: number } => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { calls: 0 });
const bump = () => {
  const l = readLedger();
  l.calls += 1;
  writeFileSync(LEDGER, JSON.stringify(l));
  return l.calls;
};

function capped(inner: ModelClient): ModelClient {
  return {
    async complete(req) {
      if (readLedger().calls >= MAX) throw new ModelError('refused');
      bump();
      return inner.complete(req);
    },
  };
}

// ---------------------------------------------------------------- checks

/** Verbs a quote bullet may open with (lowercase). */
const VERBS = new Set([
  ...FJC_SCOPE_VOICE_V2.examples.flatMap((e) => e.wording.flatMap((w) => w.steps.map((b) => (b.match(/[\p{L}'-]+/u)?.[0] ?? '').toLowerCase()))),
  'install', 'remove', 'strip', 'erect', 'strike', 'lay', 'provide', 'supply', 'deliver', 'fit', 'replace', 'repoint', 'rake', 'rebed', 're-bed',
  'reseal', 'reinstall', 're-install', 're-roof', 'reroof', 'inspect', 'check', 'clear', 'clean', 'cut', 'create', 'strengthen', 'dispose', 'seal',
  'fix', 'renew', 'dress', 'apply', 'build', 'form', 'prepare', 'repair', 'paint', 'treat', 'fill', 'point', 'bed', 'carry', 'allow', 'cover', 'protect',
  'take', 'set', 'put', 'make', 'tile', 'hang', 'lift', 'move', 'sort', 'take', 'demolish', 'dismantle', 'scaffold', 'board', 'batten', 'felt', 'lead',
]);
const firstWord = (s: string) => (s.match(/[\p{L}'-]+/u)?.[0] ?? '').toLowerCase();
/** A note the owner wrote that stays a note ("site manager is Dave"): starts with the same two words as one of their steps. */
const keptNote = (bullet: string, ownerSteps: string[]) => {
  const two = (t: string) => (t.toLowerCase().match(/[\p{L}\p{Nd}']+/gu) ?? []).slice(0, 2).join(' ');
  return ownerSteps.some((o) => two(o) !== '' && two(o) === two(bullet));
};
const imperative = (s: string, ownerSteps: string[]) => VERBS.has(firstWord(s)) || keptNote(s, ownerSteps);

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

function checks(c: Case, items: ScopeItem[], r: GenerateResult): { list: Check[]; imperativeRate: number } {
  const groups = groupItems(items);
  const ownerTexts = groups.flatMap((g) => [...(g.heading ? [g.heading] : []), ...g.steps]);
  const inputTexts = [c.jobType, DEFAULT_SECTION_HEADING, ...ownerTexts];
  const bullets = r.sections.flatMap((s) => s.steps);
  const wording = r.sections.flatMap((s) => [s.heading, ...s.steps]);
  const allInput = ownerTexts.join(' ').toLowerCase();
  const inventions = findInventions(inputTexts, wording);
  const inNums = new Set(ownerTexts.join(' ').match(/\d+(?:\.\d+)?/g) ?? []);
  const newNums = (wording.join(' ').match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => !inNums.has(n));
  const lost = missingFacts(ownerTexts, wording, r.corrections);
  const ownerSteps = groups.flatMap((g) => g.steps);
  const rate = bullets.length ? bullets.filter((b) => imperative(b, ownerSteps)).length / bullets.length : 0;
  const ownerWeWill = /\bwe(?: will|'ll)\b/.test(allInput);
  const weWill = bullets.filter((b) => /^we(?: will|'ll)\b/i.test(b));
  const okHeadings = new Set([DEFAULT_SECTION_HEADING, ...FJC_SCOPE_VOICE_V2.headings].map((h) => h.toLowerCase()));
  const ownerHeadings = groups.filter((g) => g.heading).length;
  const badHeadings = ownerHeadings === 0 ? r.sections.map((s) => s.heading).filter((h) => !okHeadings.has(h.toLowerCase())) : [];
  const text = [...wording, ...r.corrections, ...r.uncertain, ...r.suggestions.map((s) => s.question)].join('\n');
  const list: Check[] = [
    { name: 'AI wording used (not the basic tidy)', pass: r.engine === 'ai', detail: r.notice ?? undefined },
    { name: 'Invention check passes', pass: inventions.length === 0, detail: inventions.map((i) => `${i.kind}:${i.word}`).join(', ') },
    { name: 'No new numbers (and digits only where the owner used digits)', pass: newNums.length === 0, detail: newNums.join(', ') },
    { name: 'Every figure and name kept', pass: lost.length === 0, detail: lost.map((l) => l.text).join(', ') },
    { name: 'Imperative voice, owner notes aside (90% or more)', pass: rate >= 0.9, detail: `${Math.round(rate * 100)}%` },
    { name: "No 'We will' unless the owner wrote it", pass: ownerWeWill || weWill.length === 0, detail: weWill.join(' | ') },
    { name: 'No passive "will be"', pass: !bullets.some((b) => /\bwill be\b/i.test(b)) },
    { name: 'Headings: owner, "The works" or the business list', pass: badHeadings.length === 0, detail: badHeadings.join(', ') },
    { name: 'Please-check items are questions', pass: r.uncertain.every((u) => u.trim().endsWith('?')) },
    { name: 'Corrections in the Read ... as ... form', pass: r.corrections.every((x) => /^Read '.+' as(?: '.+'|: \(removed\))\.?$/.test(x)) || r.engine !== 'ai' },
    { name: 'Suggestions are questions, not in the wording', pass: r.suggestions.every((s) => s.question.endsWith('?') && !wording.join(' ').includes(s.question)) },
    { name: 'No dashes or "actually"', pass: !/[–—]/.test(text) && !/\bactually\b/i.test(text) },
  ];
  return { list, imperativeRate: rate };
}

// ---------------------------------------------------------------- run

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cfg = aiConfig();
  if (!cfg) {
    console.error('ANTHROPIC_API_KEY is not set. Run with --env-file=.env.local.');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const label = (arg('label') ?? 'run').replace(/[^\w-]/g, '');
  const only = arg('only')?.split(',').map((n) => Number(n.trim()));
  const client = capped(anthropicClient(cfg));
  const before = readLedger().calls;
  console.log(`model ${cfg.model}, prompt ${SCOPE_COPY_PROMPT_VERSION}, voice ${FJC_SCOPE_VOICE_V2.version}, calls so far ${before}/${MAX}`);

  const lines: string[] = [`# Scope wording evaluation: ${label}`, '', `Model ${cfg.model}. Prompt ${SCOPE_COPY_PROMPT_VERSION}. Voice ${FJC_SCOPE_VOICE_V2.version}. Inputs are made up.`, ''];
  let passedAll = 0;
  let ran = 0;
  const rates: number[] = [];
  for (const [i, c] of CASES.entries()) {
    if (only && !only.includes(i + 1)) continue;
    ran += 1;
    const items: ScopeItem[] = c.steps.map((t, j) => ({ id: `e${j}`, kind: t.startsWith('#') ? 'heading' : 'step', text: t.replace(/^#/, '') }));
    const t0 = Date.now();
    const rejected: string[] = [];
    const r = await generateScopeCopy({ steps: items, jobType: c.jobType, typicalSteps: typicalStepsFrom(c.key ? FJC_SCOPE_EXAMPLES[c.key] : null), voice: FJC_SCOPE_VOICE_V2 }, { client, model: cfg.model, budgetMs: 60_000, onReject: (why) => rejected.push(why) });
    const ms = Date.now() - t0;
    const { list, imperativeRate } = checks(c, items, r);
    rates.push(imperativeRate);
    const ok = list.every((x) => x.pass);
    if (ok) passedAll += 1;
    console.log(`${i + 1}. ${ok ? 'PASS' : 'FAIL'} ${c.name} (${r.engine}, ${ms} ms)${rejected.length ? ` rejected: ${rejected.join('; ')}` : ''}`);
    lines.push(`## ${i + 1}. ${c.name} (${c.jobType}): ${ok ? 'all checks pass' : 'CHECKS FAIL'}`, '');
    lines.push('Input:', '', ...c.steps.map((s) => (s.startsWith('#') ? `- **${s.slice(1)}**` : `- ${s}`)), '');
    lines.push(`Output (${r.engine}, ${ms} ms, tokens in ${r.usage?.inputTokens ?? '-'} / out ${r.usage?.outputTokens ?? '-'}):`, '');
    for (const s of r.sections) lines.push(`**${s.heading}**`, '', ...s.steps.map((b) => `- ${b}`), '');
    lines.push('Corrections:', '', ...(r.corrections.length ? r.corrections.map((x) => `- ${x}`) : ['- (none)']), '');
    lines.push('Please check:', '', ...(r.uncertain.length ? r.uncertain.map((x) => `- ${x}`) : ['- (none)']), '');
    lines.push('Things you could add:', '', ...(r.suggestions.length ? r.suggestions.map((x) => `- ${x.question}${x.step ? ` (adds: ${x.step})` : ''}`) : ['- (none)']), '');
    if (r.notice) lines.push(`Notice: ${r.notice}`, '');
    if (rejected.length) lines.push(`Answers thrown away by the checks: ${rejected.join('; ')}`, '');
    lines.push('Checks:', '', ...list.map((x) => `- [${x.pass ? 'x' : ' '}] ${x.name}${x.detail ? `: ${x.detail}` : ''}`), '');
  }
  const after = readLedger().calls;
  const avg = rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) : 0;
  lines.splice(4, 0, `Summary: ${passedAll}/${ran} cases pass every check. Average imperative rate ${avg}%. Model calls this run ${after - before}, total ${after}/${MAX}.`, '');
  const file = path.join(OUT, `report-${label}.md`);
  writeFileSync(file, lines.join('\n'));
  console.log(`${passedAll}/${ran} pass; calls this run ${after - before}, total ${after}/${MAX}; report ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  // Never print the request: only the error's name and code.
  console.error(`eval failed: ${e instanceof Error ? e.name : 'error'}${e instanceof ModelError ? ` ${e.code}` : ''}`);
  process.exit(1);
});
