/**
 * Unit tests for PollOptionsService pure helpers — label normalization (dedup
 * key) and options_config parsing/validation (no D1).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeLabel,
  parseOptionsConfig,
  buildOptionsConfig,
  DEFAULT_CAP,
  DEFAULT_WRITEINS_PER_USER,
} from '../../worker/services/PollOptionsService';

describe('PollOptions / normalizeLabel', () => {
  it('trims, lowercases, and collapses internal whitespace', () => {
    expect(normalizeLabel('  Hello   World  ')).toBe('hello world');
    expect(normalizeLabel('CAFFEINE')).toBe('caffeine');
    expect(normalizeLabel('a\t b\n c')).toBe('a b c');
  });

  it('treats case/spacing variants as the same dedup key', () => {
    expect(normalizeLabel('Drug Of Choice')).toBe(normalizeLabel('  drug  of  choice '));
  });
});

describe('PollOptions / parseOptionsConfig', () => {
  it('returns null for closed MC (null / malformed / open!=true)', () => {
    expect(parseOptionsConfig(null)).toBeNull();
    expect(parseOptionsConfig(undefined)).toBeNull();
    expect(parseOptionsConfig('not json')).toBeNull();
    expect(parseOptionsConfig(JSON.stringify({ open: false }))).toBeNull();
    expect(parseOptionsConfig(JSON.stringify({ cap: 10 }))).toBeNull();
  });

  it('parses an open config and applies defaults', () => {
    expect(parseOptionsConfig(JSON.stringify({ open: true }))).toEqual({
      open: true,
      cap: DEFAULT_CAP,
      writeins_per_user: DEFAULT_WRITEINS_PER_USER,
    });
  });

  it('honors explicit cap / writeins_per_user and floors them', () => {
    expect(parseOptionsConfig(JSON.stringify({ open: true, cap: 12, writeins_per_user: 2 }))).toEqual({
      open: true, cap: 12, writeins_per_user: 2,
    });
    expect(parseOptionsConfig(JSON.stringify({ open: true, cap: 8.9, writeins_per_user: 0 }))).toEqual({
      open: true, cap: 8, writeins_per_user: 0,
    });
  });

  it('clamps a non-positive / non-finite cap back to the default', () => {
    expect(parseOptionsConfig(JSON.stringify({ open: true, cap: 0 }))?.cap).toBe(DEFAULT_CAP);
    expect(parseOptionsConfig(JSON.stringify({ open: true, cap: -5 }))?.cap).toBe(DEFAULT_CAP);
  });
});

describe('PollOptions / buildOptionsConfig', () => {
  it('rejects non-open submissions', () => {
    expect(buildOptionsConfig(null)).toBeNull();
    expect(buildOptionsConfig({})).toBeNull();
    expect(buildOptionsConfig({ open: false })).toBeNull();
    expect(buildOptionsConfig('open')).toBeNull();
  });

  it('normalizes an open submission with defaults', () => {
    expect(buildOptionsConfig({ open: true })).toEqual({
      open: true, cap: DEFAULT_CAP, writeins_per_user: DEFAULT_WRITEINS_PER_USER,
    });
    expect(buildOptionsConfig({ open: true, cap: 6, writeins_per_user: 3 })).toEqual({
      open: true, cap: 6, writeins_per_user: 3,
    });
  });
});
