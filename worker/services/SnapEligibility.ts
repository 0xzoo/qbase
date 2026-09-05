/**
 * Snap Eligibility
 *
 * Shared module — extracted from worker/routes/farcaster.ts (isSnapEligible)
 * as part of the signerless question-creation plan (Phase 1/2). Determines
 * whether a question can be rendered as a Farcaster snap.
 *
 * Snap-eligible: mc, text, scale, checkbox (<=6 options).
 * Not eligible: date, scale_range, checkbox (>6 options), unknown types.
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
