/**
 * Batch re-classification — Track B2 of docs/plans/wave-governance-roadmap.md.
 *
 * Pulls every question from D1, runs the five-axis Haiku classifier, and
 * diffs the derived `primary_type` against the stored one. Agreeing rows get
 * the axes + derived labels backfilled (additive: stored v1 facets and
 * `primary_type` are kept). Disagreeing rows are the review queue and are
 * only written with --apply-all (stored label moves to `primary_type_v1`).
 * Rows with no stored taxonomy take the new classification wholesale.
 *
 * Dry-run by default. Always writes a JSON report (previous taxonomy included
 * per row, so any write can be reverted from the report).
 *
 *   npx --yes tsx scripts/reclassify-questions.ts [--db=dev|prod] [--limit=N] [--concurrency=4]
 *       [--out=<report.json>] [--from=<report.json>] [--apply] [--apply-all] [--yes]
 *
 *   --from      reuse a previous report instead of re-classifying (apply after review)
 *   --apply     write agreeing + unclassified rows
 *   --apply-all also write disagreeing rows (primary_type ← derived)
 *
 * Env (.dev.vars): OPENROUTER_API_KEY. D1 access goes through `wrangler d1
 * execute --remote`, so `wrangler login` must be current.
 */

import { config } from 'dotenv';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { classifyWithOpenRouter } from '../worker/services/taxonomy/haikuClassifier';
import type { QuestionTaxonomy } from '../worker/services/taxonomy/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
config({ path: resolve(ROOT, '.dev.vars') });

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const db = arg('db', 'dev') as 'dev' | 'prod';
const limit = arg('limit') ? parseInt(arg('limit')!, 10) : undefined;
const concurrency = parseInt(arg('concurrency', '4')!, 10);
const from = arg('from');
const applyAll = flag('apply-all');
const apply = flag('apply') || applyAll;
const out = arg('out', resolve(ROOT, `backups/reclassify-${db}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))!;

const DB_NAME = db === 'prod' ? 'prod-qbase' : 'dev-qbase';
const CONFIG = db === 'prod' ? 'wrangler.jsonc' : 'wrangler.dev.jsonc';

interface QueryRow { id: string; stem: string; a_options: string | null; taxonomy: string | null; created_at: string | null }

interface ReportRow {
  id: string;
  stem: string;
  options: string[] | null;
  stored: QuestionTaxonomy | null;
  stored_primary_type: string | null;
  derived: QuestionTaxonomy | null;
  derived_primary_type: string | null;
  status: 'agree' | 'disagree' | 'unclassified' | 'invalid' | 'error';
  error?: string;
  merged: QuestionTaxonomy | null;
}

interface Report {
  db: string;
  ran_at: string;
  classifier: string;
  rows: ReportRow[];
}

function d1(sqlOrFile: { command?: string; file?: string }): unknown {
  const args = ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--config', CONFIG, '--json'];
  if (sqlOrFile.command) args.push('--command', sqlOrFile.command);
  if (sqlOrFile.file) args.push('--file', sqlOrFile.file);
  const raw = execFileSync('npx', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const start = raw.indexOf('[');
  return JSON.parse(raw.slice(start));
}

function parseStored(raw: string | null): QuestionTaxonomy | null {
  if (!raw) return null;
  try {
    let v: unknown = JSON.parse(raw);
    if (typeof v === 'string') v = JSON.parse(v);
    return v && typeof v === 'object' ? (v as QuestionTaxonomy) : null;
  } catch {
    return null;
  }
}

function parseOptions(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/** Additive merge: stored v1 facets win; axes, derived labels, provenance come from the new classification. */
function merge(stored: QuestionTaxonomy | null, derived: QuestionTaxonomy, promote: boolean): QuestionTaxonomy {
  if (!stored) return derived;
  const merged: QuestionTaxonomy = {
    ...stored,
    referent: derived.referent,
    mode: derived.mode,
    tense: derived.tense,
    volatility: derived.volatility,
    intent: derived.intent,
    frame: derived.frame,
    resolvability: derived.resolvability,
    signal: derived.signal,
    wave_relevance: derived.wave_relevance,
    clout_eligible: derived.clout_eligible,
    ...(derived.sensitivity && !stored.sensitivity ? { sensitivity: derived.sensitivity } : {}),
    reasoning: derived.reasoning,
    taxonomy_version: 2,
    classifier: derived.classifier,
    classified_at: derived.classified_at,
  };
  if (promote && stored.primary_type !== derived.primary_type) {
    merged.primary_type = derived.primary_type;
    merged.primary_type_v1 = stored.primary_type;
  }
  return merged;
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

async function classifyAll(): Promise<Report> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY missing from .dev.vars');

  const sql = `SELECT id, stem, a_options, taxonomy, created_at FROM queries ORDER BY created_at ASC${limit ? ` LIMIT ${limit}` : ''}`;
  const res = d1({ command: sql }) as Array<{ results: QueryRow[] }>;
  const rows = res[0]?.results ?? [];
  console.log(`${DB_NAME}: ${rows.length} questions\n`);

  let classifier = '';
  let done = 0;
  const report: ReportRow[] = await mapLimit(rows, concurrency, async (row) => {
    const stored = parseStored(row.taxonomy);
    const options = parseOptions(row.a_options);
    const base: Omit<ReportRow, 'derived' | 'derived_primary_type' | 'status' | 'merged'> = {
      id: row.id, stem: row.stem, options, stored, stored_primary_type: stored?.primary_type ?? null,
    };
    try {
      const derived = await classifyWithOpenRouter(apiKey, row.stem, options ?? undefined);
      classifier = derived.classifier ?? classifier;
      let status: ReportRow['status'];
      if (derived.primary_type === 'invalid') status = 'invalid';
      else if (!stored) status = 'unclassified';
      else if (stored.primary_type === derived.primary_type) status = 'agree';
      else status = 'disagree';
      const merged = status === 'invalid' ? null : merge(stored, derived, status === 'disagree');
      done++;
      process.stdout.write(`\r  classified ${done}/${rows.length}`);
      return { ...base, derived, derived_primary_type: derived.primary_type, status, merged };
    } catch (e) {
      done++;
      return { ...base, derived: null, derived_primary_type: null, status: 'error', error: e instanceof Error ? e.message : String(e), merged: null };
    }
  });
  process.stdout.write('\n');
  return { db: DB_NAME, ran_at: new Date().toISOString(), classifier, rows: report };
}

function printSummary(report: Report) {
  const by = (s: ReportRow['status']) => report.rows.filter((r) => r.status === s);
  console.log(`\n── ${report.db} · ${report.rows.length} rows · classifier ${report.classifier} ──`);
  console.log(`agree        ${by('agree').length}`);
  console.log(`disagree     ${by('disagree').length}   ← review queue`);
  console.log(`unclassified ${by('unclassified').length}   (no stored taxonomy)`);
  console.log(`invalid      ${by('invalid').length}   (classifier says not a question — left untouched)`);
  console.log(`error        ${by('error').length}`);

  const axes = (t: QuestionTaxonomy | null) => (t?.mode ? `${t.referent}/${t.mode}/${t.tense}/${t.volatility}/${t.intent}` : '—');

  const dis = by('disagree');
  if (dis.length) {
    console.log('\n── review queue (stored → derived) ──');
    for (const r of dis) {
      console.log(`\n${r.id}  ${r.stored_primary_type} → ${r.derived_primary_type}  [${axes(r.derived)}]`);
      console.log(`  "${r.stem}"${r.options ? `  [${r.options.join(' | ')}]` : ''}`);
      if (r.derived?.reasoning) console.log(`  ${r.derived.reasoning}`);
    }
  }
  const req = report.rows.filter((r) => r.derived?.intent === 'request');
  if (req.length) {
    console.log(`\n── intent = request (${req.length}) ──`);
    for (const r of req) console.log(`  ${r.id}  ${r.derived_primary_type}  "${r.stem}"`);
  }
  const inv = by('invalid');
  if (inv.length) {
    console.log(`\n── classifier says invalid (${inv.length}) ──`);
    for (const r of inv) console.log(`  ${r.id}  "${r.stem}"  ${r.derived?.reasoning ?? ''}`);
  }
  const errs = by('error');
  if (errs.length) {
    console.log(`\n── errors (${errs.length}) ──`);
    for (const r of errs) console.log(`  ${r.id}  ${r.error}`);
  }
}

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

function applyReport(report: Report) {
  const targets = report.rows.filter((r) =>
    r.merged && (r.status === 'agree' || r.status === 'unclassified' || (applyAll && r.status === 'disagree')),
  );
  if (targets.length === 0) {
    console.log('\nnothing to apply');
    return;
  }
  const statements = targets.map((r) => `UPDATE queries SET taxonomy = ${sqlStr(JSON.stringify(r.merged))} WHERE id = ${sqlStr(r.id)};`);
  const dir = mkdtempSync(join(tmpdir(), 'reclassify-'));
  const file = join(dir, `apply-${report.db}.sql`);
  writeFileSync(file, statements.join('\n') + '\n');
  console.log(`\napplying ${targets.length} UPDATEs to ${report.db} (${applyAll ? 'agree + unclassified + disagree' : 'agree + unclassified'})…`);
  const res = d1({ file }) as Array<{ success?: boolean; meta?: { changes?: number } }>;
  const changes = res.reduce((s, r) => s + (r.meta?.changes ?? 0), 0);
  console.log(`done: ${changes} rows changed (sql kept at ${file})`);
}

async function main() {
  const report: Report = from
    ? (JSON.parse(readFileSync(from, 'utf8')) as Report)
    : await classifyAll();
  if (!from) {
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`report → ${out}`);
  }
  printSummary(report);
  if (apply) {
    if (from && report.db !== DB_NAME) throw new Error(`report is for ${report.db}, --db says ${DB_NAME}`);
    applyReport(report);
  } else {
    console.log(`\ndry run. re-run with --from=${from ?? out} --db=${db} --apply (agreeing rows) or --apply-all (after review).`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
