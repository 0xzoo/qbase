/**
 * Classifier gate — Track B1 of docs/plans/wave-governance-roadmap.md.
 *
 * Runs the canonical test set (worker/services/taxonomy/testSet.ts) through
 * the five-axis OpenRouter classifier (default model) and the legacy 3B
 * decision tree (Workers AI REST) and reports pass rate, latency, and
 * per-case disagreements; --models=… compares arbitrary OpenRouter models. The legacy path returns no axes, so it is scored on
 * `primary_type` + construction/template/tags only.
 *
 * Run:  npx --yes tsx scripts/taxonomy-gate.ts [--classifier=both|openrouter|legacy] [--runs=1]
 *         [--only=<substring of case name>] [--out=<path.json>]
 *       npx --yes tsx scripts/taxonomy-gate.ts --models=z-ai/glm-5.3-flash,qwen/qwen3.8-flash [--reasoning=low|off]
 *         [--max-tokens=1500] [--concurrency=4]   → any OpenRouter model ids, with measured cost per call
 * Env (.dev.vars): OPENROUTER_API_KEY, WORKERS_AI_API_KEY (or CLOUDFLARE_API_TOKEN, e.g. the
 *   oauth_token from ~/.wrangler/config/default.toml), CLOUDFLARE_ACCOUNT_ID (or --account=<id>)
 */

import { config } from 'dotenv';
import { writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { AIService, type ClassifierChoice } from '../worker/services/AIService';
import {
  classifyWithOpenRouter,
  type OpenRouterClassifierOptions, type OpenRouterUsage,
} from '../worker/services/taxonomy/openRouterClassifier';
import { TAXONOMY_TEST_SET, checkTaxonomy, type TaxonomyTestCase } from '../worker/services/taxonomy/testSet';
import type { QuestionTaxonomy } from '../worker/services/taxonomy/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.dev.vars') });

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const classifierArg = (arg('classifier', 'both') === 'haiku' ? 'openrouter' : arg('classifier', 'both')) as 'both' | 'openrouter' | 'legacy';
const runs = parseInt(arg('runs', '1')!, 10);
const only = arg('only');
const out = arg('out');
const accountId = arg('account', process.env.CLOUDFLARE_ACCOUNT_ID);
// A wrangler OAuth token (CLOUDFLARE_API_TOKEN) works too — it carries the `ai` scope.
const workersAiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.WORKERS_AI_API_KEY;
const openRouterKey = process.env.OPENROUTER_API_KEY;

// ── model-comparison mode: --models=<openrouter ids> ──
const modelsArg = arg('models');
const reasoningArg = arg('reasoning') as 'low' | 'medium' | 'high' | 'off' | undefined;
const maxTokensArg = arg('max-tokens');
const concurrency = parseInt(arg('concurrency', '4')!, 10);

const choices: ClassifierChoice[] = classifierArg === 'both' ? ['openrouter', 'legacy'] : [classifierArg];

if (modelsArg && !openRouterKey) {
  console.error('OPENROUTER_API_KEY missing from .dev.vars');
  process.exit(1);
}
if (!modelsArg && choices.includes('openrouter') && !openRouterKey) {
  console.error('OPENROUTER_API_KEY missing from .dev.vars');
  process.exit(1);
}
if (!modelsArg && choices.includes('legacy') && (!workersAiToken || !accountId)) {
  console.error('legacy baseline needs WORKERS_AI_API_KEY in .dev.vars and CLOUDFLARE_ACCOUNT_ID (or --account=)');
  process.exit(1);
}

// Workers AI over REST, shaped like the `env.AI` binding (`run(model, params) → { response }`).
const restAi = {
  run: async (model: string, params: unknown) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workersAiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = (await res.json()) as { success?: boolean; result?: unknown; errors?: unknown };
    if (!res.ok || json.success === false) {
      throw new Error(`workers ai ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 200)}`);
    }
    return json.result as { response?: unknown };
  },
};

const service = new AIService(restAi, openRouterKey);

interface CaseResult {
  name: string;
  stem: string;
  classifier: ClassifierChoice;
  run: number;
  passed: boolean;
  errors: string[];
  latencyMs: number;
  primary_type?: string;
  axes?: string;
  result?: QuestionTaxonomy;
}

function axesOf(t: QuestionTaxonomy): string {
  if (!t.mode) return '—';
  return `${t.referent}/${t.mode}/${t.tense}/${t.volatility}/${t.intent}`;
}

async function runCase(tc: TaxonomyTestCase, classifier: ClassifierChoice, run: number): Promise<CaseResult> {
  const start = Date.now();
  try {
    const result = await service.classifyQuestion(tc.stem, tc.options, classifier);
    const errors = checkTaxonomy(result, tc.expected);
    return {
      name: tc.name, stem: tc.stem, classifier, run, passed: errors.length === 0, errors,
      latencyMs: Date.now() - start, primary_type: result.primary_type, axes: axesOf(result), result,
    };
  } catch (e) {
    return {
      name: tc.name, stem: tc.stem, classifier, run, passed: false,
      errors: [`error: ${e instanceof Error ? e.message : String(e)}`], latencyMs: Date.now() - start,
    };
  }
}

interface ModelPricing { prompt: number; completion: number }

/** Public OpenRouter model list → $/token for the ids we care about. */
async function fetchPricing(ids: string[]): Promise<Record<string, ModelPricing>> {
  const out: Record<string, ModelPricing> = {};
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    const json = (await res.json()) as { data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };
    for (const m of json.data) {
      if (ids.includes(m.id)) {
        out[m.id] = { prompt: parseFloat(m.pricing?.prompt ?? '0'), completion: parseFloat(m.pricing?.completion ?? '0') };
      }
    }
  } catch (e) {
    console.warn('pricing lookup failed:', e instanceof Error ? e.message : String(e));
  }
  return out;
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

interface ModelSummary {
  model: string;
  passed: number;
  total: number;
  passRate: string;
  primaryTypePassed: number;
  meanLatencyMs: number;
  p90LatencyMs: number;
  meanPromptTokens: number;
  meanCompletionTokens: number;
  meanReasoningTokens: number;
  /** Measured from OpenRouter's usage.cost when present, else list price × tokens. */
  usdPerCall: number | null;
  usdPer1kCalls: number | null;
  errors: number;
}

async function compareModels(cases: TaxonomyTestCase[]) {
  const models = modelsArg!.split(',').map((m) => m.trim()).filter(Boolean);
  const pricing = await fetchPricing(models);
  const baseOpts: OpenRouterClassifierOptions = {};
  if (reasoningArg === 'off') baseOpts.reasoning = { enabled: false };
  else if (reasoningArg) baseOpts.reasoning = { effort: reasoningArg };
  if (maxTokensArg) baseOpts.maxTokens = parseInt(maxTokensArg, 10);

  console.log(`taxonomy gate — model comparison — ${cases.length} cases × ${models.length} model(s)${reasoningArg ? ` (reasoning=${reasoningArg})` : ''}\n`);

  const summaries: ModelSummary[] = [];
  const perModel: Record<string, Array<{ name: string; stem: string; passed: boolean; errors: string[]; primary_type?: string; axes?: string; latencyMs: number }>> = {};
  for (const model of models) {
    const usages: OpenRouterUsage[] = [];
    const rows = await mapLimit(cases, concurrency, async (tc) => {
      const start = Date.now();
      try {
        const result = await classifyWithOpenRouter(openRouterKey!, tc.stem, tc.options, {
          ...baseOpts, model, onUsage: (u) => usages.push(u),
        });
        const errors = checkTaxonomy(result, tc.expected);
        return { name: tc.name, stem: tc.stem, passed: errors.length === 0, errors, primary_type: result.primary_type, axes: axesOf(result), latencyMs: Date.now() - start };
      } catch (e) {
        return { name: tc.name, stem: tc.stem, passed: false, errors: [`error: ${e instanceof Error ? e.message : String(e)}`], latencyMs: Date.now() - start };
      }
    });
    perModel[model] = rows;

    const passed = rows.filter((r) => r.passed).length;
    const ptPassed = rows.filter((r) => !r.errors.some((e) => e.startsWith('primary_type') || e.startsWith('error'))).length;
    const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const pt = mean(usages.map((u) => u.prompt_tokens ?? 0));
    const ct = mean(usages.map((u) => u.completion_tokens ?? 0));
    const rt = mean(usages.map((u) => u.reasoning_tokens ?? 0));
    const measured = usages.filter((u) => typeof u.cost === 'number');
    let usdPerCall: number | null = null;
    if (measured.length) usdPerCall = mean(measured.map((u) => u.cost!));
    else if (pricing[model]) usdPerCall = pt * pricing[model].prompt + ct * pricing[model].completion;

    const summary: ModelSummary = {
      model, passed, total: rows.length, passRate: `${((passed / rows.length) * 100).toFixed(1)}%`,
      primaryTypePassed: ptPassed,
      meanLatencyMs: Math.round(mean(lat)), p90LatencyMs: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.9))] ?? 0,
      meanPromptTokens: Math.round(pt), meanCompletionTokens: Math.round(ct), meanReasoningTokens: Math.round(rt),
      usdPerCall, usdPer1kCalls: usdPerCall === null ? null : usdPerCall * 1000,
      errors: rows.filter((r) => r.errors.some((e) => e.startsWith('error'))).length,
    };
    summaries.push(summary);

    console.log(`\n${model}: ${passed}/${rows.length} full, ${ptPassed}/${rows.length} primary_type, mean ${summary.meanLatencyMs}ms, ~$${summary.usdPer1kCalls === null ? '?' : summary.usdPer1kCalls.toFixed(2)}/1k calls${rt ? ` (reasoning ~${Math.round(rt)} tok)` : ''}`);
    for (const r of rows) {
      if (!r.passed) console.log(`  ✗ ${r.stem.slice(0, 60)}  [${r.axes ?? '—'}]  ${r.errors.join(' | ').slice(0, 160)}`);
    }
  }

  console.log('\n── summary ──');
  console.log(`${'model'.padEnd(36)} ${'full'.padStart(6)} ${'p_type'.padStart(7)} ${'mean ms'.padStart(8)} ${'p90 ms'.padStart(7)} ${'out tok'.padStart(8)} ${'$/1k'.padStart(7)}`);
  for (const s of summaries) {
    console.log(`${s.model.padEnd(36)} ${`${s.passed}/${s.total}`.padStart(6)} ${`${s.primaryTypePassed}/${s.total}`.padStart(7)} ${String(s.meanLatencyMs).padStart(8)} ${String(s.p90LatencyMs).padStart(7)} ${String(s.meanCompletionTokens).padStart(8)} ${(s.usdPer1kCalls === null ? '?' : s.usdPer1kCalls.toFixed(2)).padStart(7)}`);
  }
  if (out) {
    writeFileSync(out, JSON.stringify({ ran_at: new Date().toISOString(), reasoning: reasoningArg ?? null, summaries, results: perModel }, null, 2));
    console.log(`\nwrote ${out}`);
  }
}

async function main() {
  const cases = only ? TAXONOMY_TEST_SET.filter((c) => c.name.includes(only)) : TAXONOMY_TEST_SET;
  if (modelsArg) {
    await compareModels(cases);
    return;
  }
  console.log(`taxonomy gate — ${cases.length} cases × ${choices.join('+')} × ${runs} run(s)\n`);

  const all: CaseResult[] = [];
  for (const tc of cases) {
    const perClassifier: Record<string, CaseResult[]> = {};
    for (const classifier of choices) {
      perClassifier[classifier] = [];
      for (let run = 0; run < runs; run++) {
        const r = await runCase(tc, classifier, run);
        perClassifier[classifier].push(r);
        all.push(r);
      }
    }
    const cells = choices.map((c) => {
      const rs = perClassifier[c];
      const ok = rs.filter((r) => r.passed).length;
      const mark = ok === rs.length ? '✓' : ok === 0 ? '✗' : '~';
      const ms = Math.round(rs.reduce((s, r) => s + r.latencyMs, 0) / rs.length);
      return `${c}: ${mark} ${rs[0].primary_type ?? '?'} [${rs[0].axes ?? '—'}] ${ms}ms`;
    });
    console.log(`${tc.name}\n  "${tc.stem}"${tc.options ? ` [${tc.options.join(' | ')}]` : ''}\n  ${cells.join('\n  ')}`);
    for (const c of choices) {
      for (const r of perClassifier[c]) {
        for (const e of r.errors) console.log(`    ${c}${runs > 1 ? `#${r.run}` : ''}: ${e}`);
      }
    }
  }

  console.log('\n── summary ──');
  const summary: Record<string, { total: number; passed: number; passRate: string; meanLatencyMs: number; p90LatencyMs: number }> = {};
  for (const c of choices) {
    const rs = all.filter((r) => r.classifier === c);
    const passed = rs.filter((r) => r.passed).length;
    const lat = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
    const p90 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.9))] ?? 0;
    summary[c] = {
      total: rs.length, passed,
      passRate: `${((passed / Math.max(1, rs.length)) * 100).toFixed(1)}%`,
      meanLatencyMs: Math.round(lat.reduce((s, x) => s + x, 0) / Math.max(1, lat.length)),
      p90LatencyMs: p90,
    };
    console.log(`${c.padEnd(7)} ${summary[c].passed}/${summary[c].total} (${summary[c].passRate})  mean ${summary[c].meanLatencyMs}ms  p90 ${summary[c].p90LatencyMs}ms`);
  }

  if (choices.length === 2) {
    const dis = cases.filter((tc) => {
      const h = all.find((r) => r.classifier === 'openrouter' && r.name === tc.name);
      const l = all.find((r) => r.classifier === 'legacy' && r.name === tc.name);
      return h?.primary_type !== l?.primary_type;
    });
    console.log(`\nprimary_type disagreements (openrouter vs legacy): ${dis.length}`);
    for (const tc of dis) {
      const h = all.find((r) => r.classifier === 'openrouter' && r.name === tc.name);
      const l = all.find((r) => r.classifier === 'legacy' && r.name === tc.name);
      const want = Array.isArray(tc.expected.primary_type) ? tc.expected.primary_type.join('|') : tc.expected.primary_type;
      console.log(`  "${tc.stem}"  want ${want}  openrouter ${h?.primary_type}  legacy ${l?.primary_type}`);
    }
  }

  if (out) {
    writeFileSync(out, JSON.stringify({ ran_at: new Date().toISOString(), runs, summary, results: all }, null, 2));
    console.log(`\nwrote ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
