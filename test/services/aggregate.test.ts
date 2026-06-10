/**
 * Unit tests for AggregateResultsService pure helpers — distribution
 * shaping and scale-value labeling (no D1).
 */

import { describe, it, expect } from 'vitest';
import { shapeOptionDistribution, labelScaleValue } from '../../worker/services/AggregateResultsService';

describe('AggregateResults / shapeOptionDistribution', () => {
  it('orders rows by declared option order and keeps zero-count options', () => {
    const rows = shapeOptionDistribution(
      ['yes', 'no', 'maybe'],
      { no: 6, yes: 3 },
      9,
    );
    expect(rows).toEqual([
      { label: 'yes', count: 3, pct: 33 },
      { label: 'no', count: 6, pct: 67 },
      { label: 'maybe', count: 0, pct: 0 },
    ]);
  });

  it('appends stray (legacy/free) labels after declared options, sorted by count', () => {
    const rows = shapeOptionDistribution(
      ['a', 'b'],
      { a: 1, weird: 5, other: 2 },
      8,
    );
    expect(rows.map((r) => r.label)).toEqual(['a', 'b', 'weird', 'other']);
    expect(rows[2]).toEqual({ label: 'weird', count: 5, pct: 63 });
  });

  it('returns zero pcts when there are no responders', () => {
    const rows = shapeOptionDistribution(['a', 'b'], {}, 0);
    expect(rows.every((r) => r.pct === 0 && r.count === 0)).toBe(true);
  });
});

describe('AggregateResults / labelScaleValue', () => {
  it('prefers custom labels, then endpoint labels, then the bare numeric', () => {
    const config = {
      labels: { '1': 'Terrible', '10': 'Amazing' },
      customLabels: [{ value: 5, label: 'Mid' }],
    };
    expect(labelScaleValue(5, config)).toBe('5 · Mid');
    expect(labelScaleValue(1, config)).toBe('1 · Terrible');
    expect(labelScaleValue(7, config)).toBe('7');
    expect(labelScaleValue(3, null)).toBe('3');
  });
});
