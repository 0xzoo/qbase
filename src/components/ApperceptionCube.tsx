// Interactive 3D cube for the apperception result page. The user is a single
// point inside a cube whose three axes are the bipolar dimensions; the 8
// corners are the 8 styles. Drag to rotate. Pure SVG + a rotation matrix —
// no 3D dependency — so it matches the server-rendered isometric hero PNG.

import React, { useCallback, useRef, useState } from 'react';

interface Scores {
  concrete: number;
  reflective: number;
  sequential: number;
}

// y (up) = concrete, x (right) = reflective, z (depth) = sequential
const POLES = {
  concrete: { high: 'example-first', low: 'principle-first' },
  reflective: { high: 'think-first', low: 'learn-by-doing' },
  sequential: { high: 'step-by-step', low: 'big-picture' },
} as const;

const FACES: { axis: keyof typeof POLES; pole: 'high' | 'low'; at: [number, number, number] }[] = [
  { axis: 'concrete', pole: 'high', at: [0.5, 1, 0.5] },
  { axis: 'concrete', pole: 'low', at: [0.5, 0, 0.5] },
  { axis: 'reflective', pole: 'high', at: [1, 0.5, 0.5] },
  { axis: 'reflective', pole: 'low', at: [0, 0.5, 0.5] },
  { axis: 'sequential', pole: 'high', at: [0.5, 0.5, 1] },
  { axis: 'sequential', pole: 'low', at: [0.5, 0.5, 0] },
];

const VB = 360;
const OX = VB / 2;
const OY = VB / 2 + 6;
const SCALE = 108;

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
): [number, number, number] {
  const cx = x - 0.5, cy = y - 0.5, cz = z - 0.5;
  const x1 = cx * Math.cos(yaw) + cz * Math.sin(yaw);
  const z1 = -cx * Math.sin(yaw) + cz * Math.cos(yaw);
  const y2 = cy * Math.cos(pitch) - z1 * Math.sin(pitch);
  const z2 = cy * Math.sin(pitch) + z1 * Math.cos(pitch);
  return [OX + x1 * SCALE, OY - y2 * SCALE, z2];
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
  const depths = pv.map((p) => p[2]);
  const dMin = Math.min(...depths), dMax = Math.max(...depths);
  const edges = EDGES
    .map(([a, b]) => ({ a, b, t: ((depths[a] + depths[b]) / 2 - dMin) / (dMax - dMin || 1) }))
    .sort((e1, e2) => e1.t - e2.t);

  const center = project(0.5, 0.5, 0.5, yaw, pitch);
  const [ux, uy] = project(px, py, pz, yaw, pitch);
  const [fx, fy] = project(px, 0, pz, yaw, pitch);

  return (
    <svg
      viewBox={`0 0 ${VB} ${VB}`}
      width="100%"
      height={300}
      role="img"
      aria-label="your cognitive style as a point in a 3D cube — drag to rotate"
      style={{ touchAction: 'none', cursor: 'grab', userSelect: 'none', display: 'block' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    >
      {edges.map(({ a, b, t }, i) => {
        const [x1, y1] = pv[a];
        const [x2, y2] = pv[b];
        return (
          <line
            key={i}
            x1={x1} y1={y1} x2={x2} y2={y2}
            stroke="#8B5CF6"
            strokeWidth={0.6 + t}
            strokeOpacity={0.28 + 0.72 * t}
          />
        );
      })}
      <line x1={ux} y1={uy} x2={fx} y2={fy} stroke="#A78BFA" strokeWidth={1.4} strokeDasharray="3 4" />
      <ellipse cx={fx} cy={fy} rx={5} ry={3} fill="#A78BFA" fillOpacity={0.45} />
      {FACES.map(({ axis, pole, at }, i) => {
        const [sx, sy] = project(at[0], at[1], at[2], yaw, pitch);
        let dx = sx - center[0], dy = sy - center[1];
        const len = Math.hypot(dx, dy) || 1;
        return (
          <text
            key={i}
            x={sx + (dx / len) * 30}
            y={sy + (dy / len) * 30}
            fill="#64748B"
            fontSize={12}
            fontWeight={500}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {POLES[axis][pole]}
          </text>
        );
      })}
      <circle cx={ux} cy={uy} r={8} fill="#7C3AED" stroke="#FDFBF7" strokeWidth={2.5} />
    </svg>
  );
}
