// Interactive 3D cube for the apperception result page — the spatial gestalt.
// The user is a point in a 3-axis space; faint axes cross the centre (neutral)
// symmetrically and a bold vector runs from the centre to the point. Drag to
// rotate. Unlabeled (the meters alongside name every dimension/pole); pure SVG
// + a rotation matrix, matching the server-rendered hero PNG.

import React, { useCallback, useRef, useState } from 'react';

interface Scores {
  concrete: number;
  reflective: number;
  sequential: number;
}

// x = reflective, y = concrete (up), z = sequential. Faint axes cross the
// centre (neutral) symmetrically — both poles equal; the dimension name sits
// at the end of each axis (poles are named by the meters).
const AXES: { lo: [number, number, number]; hi: [number, number, number]; dim: string; hue: string }[] = [
  { lo: [0.5, 0, 0.5], hi: [0.5, 1, 0.5], dim: 'concrete', hue: '#7C3AED' },
  { lo: [0, 0.5, 0.5], hi: [1, 0.5, 0.5], dim: 'reflective', hue: '#0D9488' },
  { lo: [0.5, 0.5, 0], hi: [0.5, 0.5, 1], dim: 'sequential', hue: '#D97706' },
];

const VB = 320;
const OX = VB / 2;
const OY = VB / 2 + 6;
const SCALE = 104;

const VERTS: [number, number, number][] = [];
for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) VERTS.push([x, y, z]);
const EDGES: [number, number][] = [];
for (let a = 0; a < 8; a++) {
  for (let b = a + 1; b < 8; b++) {
    let diff = 0;
    for (let i = 0; i < 3; i++) if (VERTS[a][i] !== VERTS[b][i]) diff++;
    if (diff === 1) EDGES.push([a, b]);
  }
}

function project(
  x: number, y: number, z: number, yaw: number, pitch: number,
): [number, number] {
  const cx = x - 0.5, cy = y - 0.5, cz = z - 0.5;
  const x1 = cx * Math.cos(yaw) + cz * Math.sin(yaw);
  const z1 = -cx * Math.sin(yaw) + cz * Math.cos(yaw);
  const y2 = cy * Math.cos(pitch) - z1 * Math.sin(pitch);
  return [OX + x1 * SCALE, OY - y2 * SCALE];
}

export default function ApperceptionCube({ scores }: { scores: Scores }) {
  const [yaw, setYaw] = useState((38 * Math.PI) / 180);
  const [pitch, setPitch] = useState((20 * Math.PI) / 180);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const onDown = useCallback((e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }, []);
  const onMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setYaw((v) => v + dx * 0.01);
    setPitch((v) => Math.max(-1.3, Math.min(1.3, v + dy * 0.01)));
  }, []);
  const onUp = useCallback(() => { drag.current = null; }, []);

  const px = scores.reflective, py = scores.concrete, pz = scores.sequential;
  const pv = VERTS.map(([x, y, z]) => project(x, y, z, yaw, pitch));
  const [cx, cy] = project(0.5, 0.5, 0.5, yaw, pitch);
  const [ux, uy] = project(px, py, pz, yaw, pitch);

  return (
    <svg
      viewBox={`0 0 ${VB} ${VB}`}
      width="100%"
      height={290}
      role="img"
      aria-label="your cognitive style as a point in a 3-axis space — drag to rotate"
      style={{ touchAction: 'none', cursor: 'grab', userSelect: 'none', display: 'block' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    >
      {/* reference cube */}
      {EDGES.map(([a, b], i) => (
        <line key={`e${i}`} x1={pv[a][0]} y1={pv[a][1]} x2={pv[b][0]} y2={pv[b][1]}
          stroke="#CBD5E1" strokeWidth={0.9} strokeOpacity={0.7} />
      ))}
      {/* color-coded center axes (symmetric) + dimension name at each end */}
      {AXES.map(({ lo, hi, dim, hue }, i) => {
        const [lx, ly] = project(lo[0], lo[1], lo[2], yaw, pitch);
        const [hx, hy] = project(hi[0], hi[1], hi[2], yaw, pitch);
        const dx = hx - cx, dy = hy - cy, len = Math.hypot(dx, dy) || 1;
        return (
          <g key={`a${i}`}>
            <line x1={lx} y1={ly} x2={hx} y2={hy} stroke={hue} strokeWidth={1.3} strokeOpacity={0.55} />
            <text x={hx + (dx / len) * 16} y={hy + (dy / len) * 16} fill={hue} fontSize={11} fontWeight={700} textAnchor="middle" dominantBaseline="middle">{dim}</text>
          </g>
        );
      })}
      {/* neutral centre + lean vector ("you", needle, no point) */}
      <circle cx={cx} cy={cy} r={3.5} fill="#CBD5E1" />
      <line x1={cx} y1={cy} x2={ux} y2={uy} stroke="#334155" strokeWidth={3.5} strokeLinecap="round" />
    </svg>
  );
}
