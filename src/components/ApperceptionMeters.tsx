// Diverging meters for the apperception result page — the precise per-axis
// read that pairs with the cube. Neutral in the middle; the fill leans toward
// whichever pole. Matches the meters in the server-rendered hero PNG.

import React from 'react';

interface Scores {
  concrete: number;
  reflective: number;
  sequential: number;
}

const METERS: { dim: keyof Scores; lo: string; hi: string }[] = [
  { dim: 'concrete', lo: 'principle-first', hi: 'example-first' },
  { dim: 'reflective', lo: 'learn-by-doing', hi: 'think-first' },
  { dim: 'sequential', lo: 'big-picture', hi: 'step-by-step' },
];

export default function ApperceptionMeters({ scores }: { scores: Scores }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, width: '100%' }}>
      {METERS.map(({ dim, lo, hi }) => {
        const pct = Math.max(0, Math.min(1, scores[dim])) * 100;
        const fillLeft = Math.min(50, pct);
        const fillWidth = Math.abs(pct - 50);
        return (
          <div key={dim}>
            <div style={{ fontWeight: 700, color: '#475569', fontSize: 15, marginBottom: 6 }}>{dim}</div>
            <div style={{ position: 'relative', height: 16, borderRadius: 8, background: '#EDE7FB' }}>
              <div style={{ position: 'absolute', left: '50%', top: -4, bottom: -4, width: 2, background: '#C4B5FD' }} />
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${fillLeft}%`, width: `${fillWidth}%`, background: '#7C3AED', opacity: 0.85, borderRadius: 8 }} />
              <div style={{ position: 'absolute', top: '50%', left: `${pct}%`, transform: 'translate(-50%, -50%)', width: 18, height: 18, borderRadius: '50%', background: '#7C3AED', border: '3px solid #FDFBF7' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12, color: '#64748B' }}>
              <span>{lo}</span>
              <span>{hi}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
