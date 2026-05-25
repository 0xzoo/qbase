// apperception — "shape" PNG renderer for the result snap.
//
// Generates a 1200×900 (4:3) PNG of the user's position in a 3-axis space,
// the hero image on the result snap. Resvg-wasm rasterizes an SVG we build
// server-side (a fixed isometric projection — looks 3D, static angle).
//
// Three bipolar axes, drawn as arrowed axes from an origin corner inside a
// faint reference cube:
//   concrete    — principle-first → example-first
//   reflective  — learn-by-doing  → think-first
//   sequential  — big-picture     → step-by-step
// The user is a single point; the 8 cube corners are the 8 styles.

import type { ApperceptionScore } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

type ResvgCtor = typeof import('@cf-wasm/resvg').Resvg;
let ResvgClass: ResvgCtor | null = null;
async function loadResvg(): Promise<ResvgCtor> {
  if (!ResvgClass) {
    const mod = await import('@cf-wasm/resvg');
    ResvgClass = mod.Resvg;
  }
  return ResvgClass;
}

// Memoize the *promise* (not the array): concurrent cold requests must all
// await the same fully-populated result. Assigning an empty array up front let
// a second concurrent request render with no fonts → resvg threw "Render
// failed" (intermittent, cold-isolate only).
let fontsPromise: Promise<Uint8Array[]> | null = null;
function ensureFonts(
  assets: { fetch: (r: Request | string) => Promise<Response> },
): Promise<Uint8Array[]> {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      const paths = [
        '/fonts/AlbertSans/AlbertSans-Bold.ttf',
        '/fonts/AlbertSans/AlbertSans-Medium.ttf',
        '/fonts/AlbertSans/AlbertSans-Regular.ttf',
      ];
      const buffers: Uint8Array[] = [];
      for (const p of paths) {
        try {
          const res = await assets.fetch(new Request(`https://dummy${p}`));
          if (res.ok) buffers.push(new Uint8Array(await res.arrayBuffer()));
          else console.error(`[apperception shape] font ${p} -> HTTP ${res.status}`);
        } catch (e) {
          console.error(`[apperception shape] font load failed for ${p}:`, e);
        }
      }
      if (buffers.length === 0) {
        fontsPromise = null;
        throw new Error('shape render: no fonts loaded');
      }
      return buffers;
    })();
  }
  return fontsPromise;
}

// ─── Dimensions & palette ────────────────────────────────────────────
const WIDTH = 1200;
const HEIGHT = 900;

const BG = '#FDFBF7';          // cream
const ACCENT = '#7C3AED';      // violet-600 — the user's point + axes
const FRAME = '#C4B5FD';       // violet-300 — faint reference cube
const DROP = '#A78BFA';        // violet-400 — dropline / guides
const DIM_COLOR = '#475569';   // dimension names
const POLE_COLOR = '#64748B';  // pole labels
const FOOTER_COLOR = '#94A3B8';

// Origin corner = (reflective 0, concrete 0, sequential 0).
// x = reflective, y = concrete (up), z = sequential.
const AXES: { high: [number, number, number]; dim: string; hi: string; lo: string }[] = [
  { high: [1, 0, 0], dim: 'reflective', hi: 'think-first', lo: 'learn-by-doing' },
  { high: [0, 1, 0], dim: 'concrete', hi: 'example-first', lo: 'principle-first' },
  { high: [0, 0, 1], dim: 'sequential', hi: 'step-by-step', lo: 'big-picture' },
];

// Fixed isometric view for the static hero.
const YAW = (38 * Math.PI) / 180;
const PITCH = (20 * Math.PI) / 180;
const SCALE = 300;
const OX = WIDTH / 2;
const OY = HEIGHT / 2 + 30;

function project(x: number, y: number, z: number): [number, number, number] {
  const cx = x - 0.5, cy = y - 0.5, cz = z - 0.5;
  const x1 = cx * Math.cos(YAW) + cz * Math.sin(YAW);
  const z1 = -cx * Math.sin(YAW) + cz * Math.cos(YAW);
  const y2 = cy * Math.cos(PITCH) - z1 * Math.sin(PITCH);
  const z2 = cy * Math.sin(PITCH) + z1 * Math.cos(PITCH);
  return [OX + x1 * SCALE, OY - y2 * SCALE, z2];
}

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

function arrowHead(sx: number, sy: number, ex: number, ey: number, size: number, color: string): string {
  const dx = ex - sx, dy = ey - sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;       // along
  const pxv = -uy, pyv = ux;                 // perpendicular
  const b1x = ex - ux * size + pxv * size * 0.5;
  const b1y = ey - uy * size + pyv * size * 0.5;
  const b2x = ex - ux * size - pxv * size * 0.5;
  const b2y = ey - uy * size - pyv * size * 0.5;
  return `<polygon points="${ex.toFixed(1)},${ey.toFixed(1)} ${b1x.toFixed(1)},${b1y.toFixed(1)} ${b2x.toFixed(1)},${b2y.toFixed(1)}" fill="${color}" />`;
}

const f1 = (n: number) => n.toFixed(1);

export function buildShapeSvg(
  scores: ApperceptionScore,
  opts?: { badge?: string },
): string {
  const px = scores.reflective, py = scores.concrete, pz = scores.sequential;
  const [ccx, ccy] = project(0.5, 0.5, 0.5);

  // ---- faint reference cube ----
  const pv = VERTS.map(([x, y, z]) => project(x, y, z));
  const frameEls = EDGES
    .map(([a, b]) => `<line x1="${f1(pv[a][0])}" y1="${f1(pv[a][1])}" x2="${f1(pv[b][0])}" y2="${f1(pv[b][1])}" stroke="${FRAME}" stroke-width="1" stroke-opacity="0.45" />`)
    .join('');

  // ---- three arrowed axes from the origin corner ----
  const [ox, oy] = project(0, 0, 0);
  const axisEls = AXES.map(({ high, dim, hi, lo }) => {
    const [hx, hy] = project(high[0], high[1], high[2]);
    const dirx = hx - ox, diry = hy - oy;
    const len = Math.hypot(dirx, diry) || 1;
    const ux = dirx / len, uy = diry / len;
    const line = `<line x1="${f1(ox)}" y1="${f1(oy)}" x2="${f1(hx)}" y2="${f1(hy)}" stroke="${ACCENT}" stroke-width="3" />`;
    const arrow = arrowHead(ox, oy, hx, hy, 16, ACCENT);
    // dimension name at axis midpoint, nudged perpendicular-outward
    const mx = (ox + hx) / 2, my = (oy + hy) / 2;
    let nperpx = -uy, nperpy = ux;
    if ((mx - ccx) * nperpx + (my - ccy) * nperpy < 0) { nperpx = -nperpx; nperpy = -nperpy; }
    const dimEl = `<text x="${f1(mx + nperpx * 22)}" y="${f1(my + nperpy * 22)}" fill="${DIM_COLOR}" font-family="Albert Sans" font-size="27" font-weight="700" text-anchor="middle" dominant-baseline="middle">${dim}</text>`;
    // high pole just past the arrow tip
    const hiEl = `<text x="${f1(hx + ux * 46)}" y="${f1(hy + uy * 46)}" fill="${POLE_COLOR}" font-family="Albert Sans" font-size="23" font-weight="500" text-anchor="middle" dominant-baseline="middle">${hi}</text>`;
    // low pole behind the origin, along -axis (spreads the three apart)
    const loEl = `<text x="${f1(ox - ux * 92)}" y="${f1(oy - uy * 92)}" fill="${POLE_COLOR}" font-family="Albert Sans" font-size="21" font-weight="400" text-anchor="middle" dominant-baseline="middle">${lo}</text>`;
    return line + arrow + dimEl + hiEl + loEl;
  }).join('');

  // ---- user point + projection guides to the origin planes ----
  const [ux2, uy2] = project(px, py, pz);
  const [fx, fy] = project(px, 0, pz);          // floor point
  const [rx, ry] = project(px, 0, 0);           // onto reflective axis
  const [sx2, sy2] = project(0, 0, pz);         // onto sequential axis
  const guide = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${DROP}" stroke-width="2" stroke-dasharray="3 6" stroke-opacity="0.8" />`;
  const guides =
    guide(ux2, uy2, fx, fy) +   // vertical: height = concrete
    guide(fx, fy, rx, ry) +     // floor → reflective axis
    guide(fx, fy, sx2, sy2) +   // floor → sequential axis
    `<ellipse cx="${f1(fx)}" cy="${f1(fy)}" rx="8" ry="4.5" fill="${DROP}" fill-opacity="0.4" />`;
  const pointEl = `<circle cx="${f1(ux2)}" cy="${f1(uy2)}" r="16" fill="${ACCENT}" stroke="${BG}" stroke-width="4" />`;

  const badgeEl = opts?.badge
    ? `<text x="60" y="80" fill="${DIM_COLOR}" font-family="Albert Sans" font-size="40" font-weight="700" text-anchor="start" letter-spacing="2">${opts.badge.toUpperCase()}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}" />
    ${badgeEl}
    ${frameEls}
    ${guides}
    ${axisEls}
    ${pointEl}
    <text x="${WIDTH / 2}" y="${HEIGHT - 44}" fill="${FOOTER_COLOR}" font-family="Albert Sans" font-size="26" font-weight="500" text-anchor="middle">app·erception · by @qbase</text>
  </svg>`;
}

export async function renderShapePng(
  env: Env,
  scores: ApperceptionScore,
  opts?: { badge?: string },
): Promise<Uint8Array> {
  const fonts = await ensureFonts(env.ASSETS);
  const svg = buildShapeSvg(scores, opts);
  const Resvg = await loadResvg();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      fontBuffers: fonts,
      loadSystemFonts: false,
      defaultFontFamily: 'Albert Sans',
    },
  });
  return resvg.render().asPng();
}
