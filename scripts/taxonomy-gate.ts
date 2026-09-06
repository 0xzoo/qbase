/**
 * Classifier gate — Track B1 of docs/plans/wave-governance-roadmap.md.
 *
 * Runs the canonical test set (worker/services/taxonomy/testSet.ts) through
 * the five-axis Haiku 4.5 classifier (OpenRouter) and the legacy 3B decision
 * tree (Workers AI REST) and reports pass rate, latency, and per-case
 * disagreements. The legacy path returns no axes, so it is scored on
 * `primary_type` + construction/template/tags only.
 *
 * Run:  npx --yes tsx scripts/taxonomy-gate.ts [--classifier=both|haiku|legacy] [--runs=1]
 *         [--only=<substring of case name>] [--out=<path.json>]
 * Env (.dev.vars): OPENROUTER_API_KEY, WORKERS_AI_API_KEY (or CLOUDFLARE_API_TOKEN, e.g. the
 *   oauth_token from ~/.wrangler/config/default.toml), CLOUDFLARE_ACCOUNT_ID (or --account=<id>)
 */

import { config } from 'dotenv';
import { writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { AIService, type ClassifierChoice } from '../worker/services/AIService';
import { TAXONOMY_TEST_SET, checkTaxonomy, type TaxonomyTestCase } from '../worker/services/taxonomy/testSet';
import type { QuestionTaxonomy } from '../worker/services/taxonomy/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.dev.vars') });

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const classifierArg = arg('classifier', 'both') as 'both' | 'haiku' | 'legacy';
const runs = parseInt(arg('runs', '1')!, 10);
const only = arg('only');
const out = arg('out');
const accountId = arg('account', process.env.CLOUDFLARE_ACCOUNT_ID);
// A wrangler OAuth token (CLOUDFLARE_API_TOKEN) works too — it carries the `ai` scope.
const workersAiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.WORKERS_AI_API_KEY;
const openRouterKey = process.env.OPENROUTER_API_KEY;

const choices: ClassifierChoice[] = classifierArg === 'both' ? ['haiku', 'legacy'] : [classifierArg];

if (choices.includes('haiku') && !openRouterKey) {
  console.error('OPENROUTER_API_KEY missing from .dev.vars');
  process.exit(1);
}
if (choices.includes('legacy') && (!workersAiToken || !accountId)) {
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

async function main() {
  const cases = only ? TAXONOMY_TEST_SET.filter((c) => c.name.includes(only)) : TAXONOMY_TEST_SET;
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
      const h = all.find((r) => r.classifier === 'haiku' && r.name === tc.name);
      const l = all.find((r) => r.classifier === 'legacy' && r.name === tc.name);
      return h?.primary_type !== l?.primary_type;
    });
    console.log(`\nprimary_type disagreements (haiku vs legacy): ${dis.length}`);
    for (const tc of dis) {
      const h = all.find((r) => r.classifier === 'haiku' && r.name === tc.name);
      const l = all.find((r) => r.classifier === 'legacy' && r.name === tc.name);
      const want = Array.isArray(tc.expected.primary_type) ? tc.expected.primary_type.join('|') : tc.expected.primary_type;
      console.log(`  "${tc.stem}"  want ${want}  haiku ${h?.primary_type}  legacy ${l?.primary_type}`);
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
