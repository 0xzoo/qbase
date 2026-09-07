/**
 * Where the oracle council applies. Shared by the worker (summon gate) and the
 * client (whether to mount the Council panel at all).
 *
 * The council is three models answering as themselves. That only makes sense
 * when the question is about the world (`referent = world`: knowledge, claims,
 * predictions) or asks for help (`intent = request`). Self-referent questions
 * — identity, mood, "do you use Instagram daily" — have no answer a model can
 * give, so no panel and no summon. v1 rows (no axes) fall back to the derived
 * label: only `knowledge` and `predictive` qualify.
 */

export interface CouncilTaxonomy {
  referent?: string;
  intent?: string;
  primary_type?: string;
}

export function councilApplies(taxonomy: CouncilTaxonomy | string | null | undefined): boolean {
  let t: CouncilTaxonomy | null = null;
  if (typeof taxonomy === 'string') {
    try { t = JSON.parse(taxonomy) as CouncilTaxonomy; } catch { t = null; }
  } else if (taxonomy && typeof taxonomy === 'object') {
    t = taxonomy;
  }
  if (!t) return false;
  if (t.intent === 'request') return true;
  if (t.referent === 'world') return true;
  if (t.referent === 'self') return false;
  // v1 (no axes): derived label only.
  return t.primary_type === 'knowledge' || t.primary_type === 'predictive';
}
