// Interactive 3D graph for the apperception result page. The user is a point
// in a 3-axis space (the bipolar dimensions); the 8 corners of the reference
// cube are the 8 styles. Drag to rotate. Pure SVG + a rotation matrix — no 3D
// dependency — so it matches the server-rendered isometric hero PNG.

import React, { useCallback, useRef, useState } from 'react';

interface Scores {
  concrete: number;
  reflective: number;
  sequential: number;
}

// x = reflective, y = concrete (up), z = sequential. Origin = all-low corner.
const AXES: { high: [number, number, number]; dim: string; hi: string; lo: string }[] = [
  { high: [1, 0, 0], dim: 'reflective', hi: 'think-first', lo: 'learn-by-doing' },
  { high: [0, 1, 0], dim: 'concrete', hi: 'example-first', lo: 'principle-first' },
  { high: [0, 0, 1], dim: 'sequential', hi: 'step-by-step', lo: 'big-picture' },
];

const VB = 360;
const OX = VB / 2;
const OY = VB / 2 + 14;
const SCALE = 96;

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

function arrowPoints(sx: number, sy: number, ex: number, ey: number, size: number): string {
  const dx = ex - sx, dy = ey - sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const px = -uy, py = ux;
  return `${ex},${ey} ${ex - ux * size + px * size * 0.5},${ey - uy * size + py * size * 0.5} ${ex - ux * size - px * size * 0.5},${ey - uy * size - py * size * 0.5}`;
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
  const [ccx, ccy] = project(0.5, 0.5, 0.5, yaw, pitch);
  const [ox, oy] = project(0, 0, 0, yaw, pitch);
  const [ux, uy] = project(px, py, pz, yaw, pitch);
  const [fx, fy] = project(px, 0, pz, yaw, pitch);
  const [rx, ry] = project(px, 0, 0, yaw, pitch);
  const [zx, zy] = project(0, 0, pz, yaw, pitch);

  return (
    <svg
      viewBox={`0 0 ${VB} ${VB}`}
      width="100%"
      height={300}
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
        <line key={i} x1={pv[a][0]} y1={pv[a][1]} x2={pv[b][0]} y2={pv[b][1]}
          stroke="#C4B5FD" strokeWidth={0.75} strokeOpacity={0.45} />
      ))}

      {/* projection guides */}
      <line x1={ux} y1={uy} x2={fx} y2={fy} stroke="#A78BFA" strokeWidth={1.2} strokeDasharray="2 4" strokeOpacity={0.8} />
      <line x1={fx} y1={fy} x2={rx} y2={ry} stroke="#A78BFA" strokeWidth={1.2} strokeDasharray="2 4" strokeOpacity={0.8} />
      <line x1={fx} y1={fy} x2={zx} y2={zy} stroke="#A78BFA" strokeWidth={1.2} strokeDasharray="2 4" strokeOpacity={0.8} />
      <ellipse cx={fx} cy={fy} rx={5} ry={3} fill="#A78BFA" fillOpacity={0.4} />

      {/* arrowed axes + labels */}
      {AXES.map(({ high, dim, hi, lo }, i) => {
        const [hx, hy] = project(high[0], high[1], high[2], yaw, pitch);
        const dirx = hx - ox, diry = hy - oy;
        const len = Math.hypot(dirx, diry) || 1;
        const dx = dirx / len, dy = diry / len;
        const mx = (ox + hx) / 2, my = (oy + hy) / 2;
        let perpx = -dy, perpy = dx;
        if ((mx - ccx) * perpx + (my - ccy) * perpy < 0) { perpx = -perpx; perpy = -perpy; }
        return (
          <g key={i}>
            <line x1={ox} y1={oy} x2={hx} y2={hy} stroke="#7C3AED" strokeWidth={1.6} />
            <polygon points={arrowPoints(ox, oy, hx, hy, 8)} fill="#7C3AED" />
            <text x={mx + perpx * 11} y={my + perpy * 11} fill="#475569" fontSize={13} fontWeight={700}
              textAnchor="middle" dominantBaseline="middle">{dim}</text>
            <text x={hx + dx * 20} y={hy + dy * 20} fill="#64748B" fontSize={11} fontWeight={500}
              textAnchor="middle" dominantBaseline="middle">{hi}</text>
            <text x={ox - dx * 26} y={oy - dy * 26} fill="#64748B" fontSize={11} fontWeight={400}
              textAnchor="middle" dominantBaseline="middle">{lo}</text>
          </g>
        );
      })}

      {/* user point */}
      <circle cx={ux} cy={uy} r={8} fill="#7C3AED" stroke="#FDFBF7" strokeWidth={2.5} />
    </svg>
  );
}
