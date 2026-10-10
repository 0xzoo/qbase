/**
 * Question hygiene at authoring (docs/plans/2026-10-11-question-hygiene.md,
 * strategy §5.1.1): a model reads a draft question and points out what would
 * make it a poor item: leading or loaded wording, two questions in one,
 * specifics that tie it to the asker (PACKS.md §4), vagueness, and options
 * that overlap or leave people out. It suggests a rewrite; the author decides.
 *
 * Same OpenRouter path and model as the classifier. Fails open: any transport,
 * HTTP or parse failure is "no issues", so a model outage never stops anyone
 * asking.
 */

import { extractJsonObject } from '../taxonomy/prompt';
import { DEFAULT_CLASSIFIER_MODEL } from '../taxonomy/openRouterClassifier';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const ISSUE_KINDS = ['leading', 'loaded', 'double_barrelled', 'specifics', 'vague', 'options_overlap', 'options_missing'] as const;
export type IssueKind = typeof ISSUE_KINDS[number];

export interface DraftQuestion {
  stem: string;
  type: string;
  options?: string[] | null;
}

export interface ReviewIssue { kind: IssueKind; note: string }

export interface ReviewResult {
  issues: ReviewIssue[];
  /** A rewrite that fixes the issues, when the model offered one that differs from the draft. */
  suggestion?: { stem: string; options?: string[] };
  /** 'model' when reviewed; 'unavailable' when it failed open. */
  reviewed: 'model' | 'unavailable';
}

export const REVIEW_SYSTEM_PROMPT = `You review draft questions for qbase, where anyone writes a question and many people answer it; the answers are counted and compared over time, so a question has to work as a survey item.

Point out only real problems, of these kinds:
- leading: the wording pushes toward one answer ("Don't you agree that...", "How much do you love...").
- loaded: emotionally charged or presumptive words, or a built-in assumption the answerer may not share ("Why is X failing?", "When did you stop...").
- double_barrelled: asks two things at once, so one answer can't fit both ("Is the city safe and affordable?").
- specifics: names a person, company, date or place tied to the asker's own situation, so the question reveals who wrote it or only fits them ("Should I leave Acme before my March vest?"). General named topics are fine ("Is Tokyo a good city for remote work?").
- vague: the answer can't be interpreted because the question doesn't say what it is about ("Do you use it often?": use what?). Everyday words people read the same way ("often", "the mainstream media", "happy") are not vague.
- options_overlap: choice options that overlap, so one answer fits two ("1-5", "5-10").
- options_missing: a large share of people could not truthfully pick any option (party options with no independent or other; age ranges with a gap). A yes/no question with yes/no options is complete.

Most questions are fine: return no issues for them. Opinion questions are allowed to be about anything; a strong topic is not a loaded question. Don't flag style, grammar or length. Questions about the answerer's own life ("How many hours do you sleep?") are good items.

When in doubt, don't flag: a false alarm costs the author more than a slightly imperfect question costs the data.

When you flag anything, suggest a rewrite that fixes it and keeps the author's meaning, voice and answer type; change as little as you can. For option issues, the fix is usually the options, not the question. If you can't tell what the author meant, flag it and give no suggestion; never put a placeholder like [topic] in one. For specifics, suggest the general question anyone could answer. Keep options if they were fine.

Reply with JSON only: {"issues": [{"kind": "...", "note": "one short sentence for the author"}], "suggestion": {"stem": "...", "options": ["..."]} or null}`;

export function buildReviewPrompt(d: DraftQuestion): string {
  const lines = [`Type: ${d.type}`, `Question: ${d.stem.trim()}`];
  if (d.options?.length) lines.push(`Options: ${d.options.map((o) => JSON.stringify(o)).join(', ')}`);
  return lines.join('\n');
}

/** The model's reply → a clean result: known kinds only, one note each, a suggestion only if it changes something. */
export function normalizeReview(parsed: Record<string, unknown>, d: DraftQuestion): ReviewResult {
  const seen = new Set<IssueKind>();
  const issues: ReviewIssue[] = [];
  for (const raw of Array.isArray(parsed.issues) ? parsed.issues : []) {
    const i = raw as Record<string, unknown>;
    const kind = i?.kind as IssueKind;
    if (!ISSUE_KINDS.includes(kind) || seen.has(kind)) continue;
    // Option issues mean nothing on a question without options.
    if (kind.startsWith('options_') && !d.options?.length) continue;
    seen.add(kind);
    issues.push({ kind, note: typeof i.note === 'string' && i.note.trim() ? i.note.trim().slice(0, 240) : kind.replace('_', ' ') });
  }
  if (issues.length === 0) return { issues, reviewed: 'model' };

  const s = parsed.suggestion as Record<string, unknown> | null | undefined;
  // A rewrite with a placeholder ("[product]") is a template, not a question the author can post.
  const raw = typeof s?.stem === 'string' ? s.stem.trim().slice(0, 300) : '';
  const stem = /[[\]{}<>]/.test(raw) ? '' : raw;
  let options: string[] | undefined;
  if (d.options?.length && Array.isArray(s?.options)) {
    const o = [...new Set((s!.options as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim().slice(0, 120)))];
    if (o.length >= 2 && o.length <= 10) options = o;
  }
  const changed = (stem && stem !== d.stem.trim()) || (options && JSON.stringify(options) !== JSON.stringify(d.options));
  return { issues, ...(changed && stem ? { suggestion: { stem, ...(options ? { options } : {}) } } : {}), reviewed: 'model' };
}

export async function reviewQuestion(
  apiKey: string | undefined,
  d: DraftQuestion,
  opts: { model?: string; fetchImpl?: typeof fetch } = {},
): Promise<ReviewResult> {
  if (!apiKey) return { issues: [], reviewed: 'unavailable' };
  try {
    const res = await (opts.fetchImpl ?? fetch)(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://qbase.tech',
        'X-Title': 'qbase question review',
      },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_CLASSIFIER_MODEL,
        messages: [
          { role: 'system', content: REVIEW_SYSTEM_PROMPT },
          { role: 'user', content: buildReviewPrompt(d) },
        ],
        max_tokens: 1500,
        temperature: 0,
        reasoning: { effort: 'low' },
      }),
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}`);
    const body = await res.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = body.choices?.[0]?.message?.content;
    const parsed = typeof text === 'string' ? extractJsonObject(text) : null;
    if (!parsed) throw new Error('reply is not JSON');
    return normalizeReview(parsed, d);
  } catch (e) {
    console.warn('[hygiene] review unavailable:', e instanceof Error ? e.message : e);
    return { issues: [], reviewed: 'unavailable' };
  }
}
