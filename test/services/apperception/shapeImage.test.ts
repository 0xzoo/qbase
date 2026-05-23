// shapeImage smoke test — verifies SVG output for all 8 archetype score patterns.
import { describe, it, expect } from 'vitest';
import { buildShapeSvg } from '../../../worker/services/apperception/shapeImage';
import type { ApperceptionScore } from '../../../worker/services/apperception/scoring';

// Archetype sign patterns (score > 0.5 = high end, ≤ 0.5 = low end)
const ARCHETYPE_SCORES: Record<string, ApperceptionScore> = {
  Architect:  { concrete: 0.7, reflective: 0.7, sequential: 0.7, confidence: 1 },
  Practitioner: { concrete: 0.7, reflective: 0.3, sequential: 0.7, confidence: 1 },
  Cartographer: { concrete: 0.7, reflective: 0.7, sequential: 0.3, confidence: 1 },
  Hacker:       { concrete: 0.7, reflective: 0.3, sequential: 0.3, confidence: 1 },
  Theorist:     { concrete: 0.3, reflective: 0.7, sequential: 0.7, confidence: 1 },
  Sprinter:     { concrete: 0.3, reflective: 0.3, sequential: 0.7, confidence: 1 },
  Navigator:    { concrete: 0.3, reflective: 0.7, sequential: 0.3, confidence: 1 },
  Builder:      { concrete: 0.3, reflective: 0.3, sequential: 0.3, confidence: 1 },
};

describe('shapeImage buildShapeSvg', () => {
  it('returns a valid SVG for each archetype', () => {
    for (const [name, scores] of Object.entries(ARCHETYPE_SCORES)) {
      const svg = buildShapeSvg(scores);
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg).toContain('1200');
      expect(svg).toContain('900');
      expect(svg).toContain('app·erception');
      // Each score produces a filled polygon
      expect(svg).toContain('<polygon points="');
      expect(svg).toContain('fill-opacity="0.2"');
    }
  });

  it('includes all three dim labels', () => {
    const svg = buildShapeSvg(ARCHETYPE_SCORES.Architect);
    expect(svg).toContain('concrete');
    expect(svg).toContain('reflective');
    expect(svg).toContain('sequential');
  });

  it('includes pole labels', () => {
    const svg = buildShapeSvg(ARCHETYPE_SCORES.Architect);
    expect(svg).toContain('example-first');
    expect(svg).toContain('principle-first');
    expect(svg).toContain('think-first');
    expect(svg).toContain('learn-by-doing');
    expect(svg).toContain('step-by-step');
    expect(svg).toContain('big-picture');
  });

  it('renders different shapes for different scores', () => {
    const extremeC = buildShapeSvg({ concrete: 0.95, reflective: 0.5, sequential: 0.5, confidence: 1 });
    const extremeP = buildShapeSvg({ concrete: 0.05, reflective: 0.5, sequential: 0.5, confidence: 1 });
    // Different score values produce different polygon point coordinates
    expect(extremeC).not.toEqual(extremeP);
  });

  it('includes badge text when provided', () => {
    const svg = buildShapeSvg(ARCHETYPE_SCORES.Architect, { badge: 'Architect' });
    expect(svg).toContain('ARCHITECT');
    expect(svg).toContain('letter-spacing="2"');
  });

  it('omits badge when opts not provided', () => {
    const svg = buildShapeSvg(ARCHETYPE_SCORES.Architect);
    expect(svg).not.toMatch(/letter-spacing="2"/);
  });

  it('uses correct palette colors', () => {
    const svg = buildShapeSvg(ARCHETYPE_SCORES.Architect);
    // Accent fill
    expect(svg).toContain('#7C3AED');
    // Footer
    expect(svg).toContain('app·erception · by @qbase');
  });

  it('contains exactly one filled score polygon', () => {
    const svg = buildShapeSvg(ARCHETYPE_SCORES.Architect);
    const fillMatches = svg.match(/fill-opacity="0\.2"/g);
    expect(fillMatches).toHaveLength(1);
  });
});
