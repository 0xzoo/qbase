import type { ScaleConfig } from './types';

/**
 * Render a scale slider value as a human-readable label.
 *
 * - 5-point scales: [min, Leaning min, Neutral, Leaning max, max]
 * - 7-point scales: [min, Mostly min, Leaning min, Neutral, Leaning max, Mostly max, max]
 * - Larger ranges (e.g., 0–100): just the numeric value, since "Leaning"/"Mostly"
 *   only make sense on small ordinal scales.
 *
 * Custom labels in `config.customLabels` are honored first.
 */
export function getScaleLabel(value: number, config: ScaleConfig): string {
  const { min, max, minLabel, maxLabel, customLabels } = config;

  if (customLabels) {
    const custom = customLabels.find(c => c.value === value);
    if (custom) return custom.label;
  }

  const range = max - min + 1;
  const position = value - min;
  const midpoint = (range - 1) / 2;

  const labelMin = minLabel || String(min);
  const labelMax = maxLabel || String(max);

  if (value === min) return labelMin;
  if (value === max) return labelMax;

  // Anything beyond a 7-point scale: just show the number.
  if (range > 7) return String(value);

  if (position === midpoint) return 'Neutral';

  const isLowerHalf = position < midpoint;
  const baseLabel = isLowerHalf ? labelMin : labelMax;
  const distanceFromEnd = isLowerHalf ? position : (range - 1 - position);

  if (distanceFromEnd === 1) {
    return range >= 7 ? `Mostly ${baseLabel}` : `Leaning ${baseLabel}`;
  }
  if (distanceFromEnd === 2) {
    return `Leaning ${baseLabel}`;
  }

  return String(value);
}

/**
 * Format an answer's `value` field for scale questions. Accepts either a
 * numeric string ("15") or already-formatted label; if the value parses as a
 * finite number, it is rendered through `getScaleLabel`. Otherwise the raw
 * string is returned (covers legacy rows submitted before the backfill ran).
 */
export function formatScaleAnswerValue(
  value: string,
  config: ScaleConfig | undefined,
): string {
  if (!config) return value;
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return value;
  return getScaleLabel(num, config);
}
