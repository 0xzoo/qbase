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
// centre (neutral) symmetrically — both poles equal.
const AXIS_PAIRS: [[number, number, number], [number, number, number]][] = [
  [[0.5, 0, 0.5], [0.5, 1, 0.5]],
  [[0, 0.5, 0.5], [1, 0.5, 0.5]],
  [[0.5, 0.5, 0], [0.5, 0.5, 1]],
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
      {/* faint reference cube */}
      {EDGES.map(([a, b], i) => (
        <line key={`e${i}`} x1={pv[a][0]} y1={pv[a][1]} x2={pv[b][0]} y2={pv[b][1]}
          stroke="#C4B5FD" strokeWidth={0.7} strokeOpacity={0.3} />
      ))}
      {/* faint center axes — both poles symmetric */}
      {AXIS_PAIRS.map(([lo, hi], i) => {
        const [lx, ly] = project(lo[0], lo[1], lo[2], yaw, pitch);
        const [hx, hy] = project(hi[0], hi[1], hi[2], yaw, pitch);
        return <line key={`a${i}`} x1={lx} y1={ly} x2={hx} y2={hy} stroke="#7C3AED" strokeWidth={1} strokeOpacity={0.35} />;
      })}
      {/* neutral centre + lean vector to the point */}
      <circle cx={cx} cy={cy} r={3.5} fill="#C4B5FD" />
      <line x1={cx} y1={cy} x2={ux} y2={uy} stroke="#7C3AED" strokeWidth={3} strokeLinecap="round" />
      <circle cx={ux} cy={uy} r={8} fill="#7C3AED" stroke="#FDFBF7" strokeWidth={2.5} />
    </svg>
  );
}
