/**
 * ValuesRadar — the five-spoke values radar, one or two profiles overlaid.
 *
 * Extracted from ValuesResult so the compare page (/values/compare) draws
 * both people on one chart. Geometry and class names are the ones the
 * result page always used (`values-radar-*`, styled in ValuesResult.css);
 * a second series adds `values-radar-score--b`.
 */

import React from 'react';

import { DIM_LABEL, SPOKE_ORDER, type ValuesAxis, type ValuesDimScores } from '../lib/valuesDims';

interface RadarProps {
  scores: ValuesDimScores;
  /** Optional second profile, drawn over the first. */
  compare?: ValuesDimScores;
  size?: number;
  ariaLabel?: string;
}

const ValuesRadar: React.FC<RadarProps> = ({ scores, compare, size = 320, ariaLabel = 'values radar' }) => {
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size * 0.4; // leave room for labels at the spokes
  const labelR = size * 0.46;

  // Convert (angleDeg from 12 o'clock, scaled radius) to (x, y).
  const point = (angleDeg: number, scale: number): [number, number] => {
    const rad = (angleDeg * Math.PI) / 180;
    return [cx + maxR * scale * Math.sin(rad), cy - maxR * scale * Math.cos(rad)];
  };
  const labelPos = (angleDeg: number): [number, number] => {
    const rad = (angleDeg * Math.PI) / 180;
    return [cx + labelR * Math.sin(rad), cy - labelR * Math.cos(rad)];
  };

  const angleFor = (dim: ValuesAxis) => {
    const idx = SPOKE_ORDER.indexOf(dim);
    return (idx * 360) / SPOKE_ORDER.length;
  };

  // Reference rings at 0.25, 0.5, 0.75, 1.0
  const rings = [0.25, 0.5, 0.75, 1.0].map((r) =>
    SPOKE_ORDER.map((d) => point(angleFor(d), r)),
  );

  const polyToString = (pts: [number, number][]) =>
    pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  const scorePoly = SPOKE_ORDER.map((d) => point(angleFor(d), scores[d]));
  const comparePoly = compare ? SPOKE_ORDER.map((d) => point(angleFor(d), compare[d])) : null;

  return (
    <svg
      className="values-radar"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={ariaLabel}
    >
      {rings.map((pts, i) => (
        <polygon
          key={i}
          points={polyToString(pts)}
          className={`values-radar-ring values-radar-ring--${i}`}
        />
      ))}
      {SPOKE_ORDER.map((d) => {
        const [x, y] = point(angleFor(d), 1);
        return (
          <line
            key={d}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            className="values-radar-spoke"
          />
        );
      })}
      <polygon points={polyToString(scorePoly)} className="values-radar-score" />
      {comparePoly ? (
        <polygon points={polyToString(comparePoly)} className="values-radar-score values-radar-score--b" />
      ) : null}
      {SPOKE_ORDER.map((d) => {
        const [x, y] = labelPos(angleFor(d));
        return (
          <text
            key={d}
            x={x}
            y={y}
            className="values-radar-label"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {DIM_LABEL[d]}
          </text>
        );
      })}
    </svg>
  );
};

export default ValuesRadar;
