/**
 * Shared Farcaster-casting helpers used by both the query-create handler and
 * the Farcaster routes. Pure functions only — no Worker env dependencies.
 */

// Circled numbers for MC options (① through ⑳)
const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

/**
 * Format cast text with answer options for MC questions.
 * Non-MC types (or MC with no options) return the stem unchanged.
 */
export function formatCastText(stem: string, type: string, options?: string[]): string {
  if (type !== 'mc' || !options || options.length === 0) {
    return stem;
  }

  const optionsText = options
    .slice(0, CIRCLED_NUMBERS.length) // Safety limit
    .map((opt, i) => `${CIRCLED_NUMBERS[i]} ${opt}`)
    .join('\n');

  return `${stem}\n\n${optionsText}`;
}

/**
 * Check if a question is snap-eligible based on its type and options.
 * Snap-eligible: mc, text, scale, checkbox (≤6 options).
 * Not eligible: scale_range, checkbox (>6 options), unknown types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function isSnapEligible(db: any, questionId: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT type, a_options FROM queries WHERE id = ?'
  ).bind(questionId).first() as { type: string; a_options?: string } | null;

  if (!row) return false;

  const { type, a_options } = row;

  switch (type) {
    case 'mc':
    case 'text':
    case 'scale':
      return true;
    case 'checkbox': {
      if (!a_options) return false;
      try {
        const parsed = JSON.parse(a_options);
        return Array.isArray(parsed) && parsed.length <= 6;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}
