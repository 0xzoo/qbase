// apperception — "shape" PNG renderer for the result snap.
//
// Generates a 1200×900 (4:3) PNG of the user's position inside a 3-axis cube,
// suitable as the hero image on the result snap. Resvg-wasm rasterizes an SVG
// we build server-side (a fixed isometric projection — looks 3D, static angle).
//
// Three bipolar axes map to the cube's edges:
//   y (up)    = concrete    (top example-first / bottom principle-first)
//   x (right) = reflective  (right think-first / left learn-by-doing)
//   z (depth) = sequential  (front step-by-step / back big-picture)
// The user is a single point in the cube; the 8 corners are the 8 styles.

import type { ApperceptionAxis } from './questions';
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
// await the same fully-populated result. The previous version assigned an
// empty array up front, so a second request arriving mid-load saw a
// truthy-but-empty `fontBuffers`, returned early, and rendered with no fonts —
// resvg then threw "Render failed" (intermittent, cold-isolate only, e.g. the
// snap hero + mini-app both requesting the shape at once).
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
        // Never cache a fontless result — reset so the next request retries.
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
const ACCENT = '#7C3AED';      // violet-600 — the user's point
const EDGE = '#8B5CF6';        // violet-500 — cube edges (depth-faded)
const DROP = '#A78BFA';        // violet-400 — dropline to floor
const POLE_COLOR = '#64748B';  // pole labels
const LABEL_COLOR = '#475569'; // style badge
const FOOTER_COLOR = '#94A3B8';

const POLES: Record<ApperceptionAxis, { high: string; low: string }> = {
  concrete: { high: 'example-first', low: 'principle-first' },
  reflective: { high: 'think-first', low: 'learn-by-doing' },
  sequential: { high: 'step-by-step', low: 'big-picture' },
};

// Fixed isometric view for the static hero.
const YAW = (38 * Math.PI) / 180;
const PITCH = (20 * Math.PI) / 180;
const SCALE = 325;
const OX = WIDTH / 2;
const OY = HEIGHT / 2 + 20;

// Project unit-cube coords (x,y,z ∈ [0,1]) → [screenX, screenY, depth].
// depth (rotated z) is used only for painter-ordering / fade.
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
    const diff = VERTS[a].reduce((n, v, i) => n + (v === VERTS[b][i] ? 0 : 1), 0);
    if (diff === 1) EDGES.push([a, b]);
  }
}

export function buildShapeSvg(
  scores: ApperceptionScore,
  opts?: { badge?: string },
): string {
  // user point: x = reflective, y = concrete, z = sequential
  const px = scores.reflective, py = scores.concrete, pz = scores.sequential;

  // ---- cube edges, painter-sorted (far first), depth-faded ----
  const pv = VERTS.map(([x, y, z]) => project(x, y, z));
  const depths = pv.map((p) => p[2]);
  const dMin = Math.min(...depths), dMax = Math.max(...depths);
  const edgeEls = EDGES
    .map(([a, b]) => ({ a, b, t: ((depths[a] + depths[b]) / 2 - dMin) / (dMax - dMin || 1) }))
    .sort((e1, e2) => e1.t - e2.t)
    .map(({ a, b, t }) => {
      const [x1, y1] = pv[a];
      const [x2, y2] = pv[b];
      const op = (0.28 + 0.72 * t).toFixed(2);
      const w = (1 + 1.6 * t).toFixed(1);
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${EDGE}" stroke-width="${w}" stroke-opacity="${op}" />`;
    })
    .join('');

  // ---- pole labels at the 6 face centers, pushed radially outward ----
  const [ccx, ccy] = project(0.5, 0.5, 0.5);
  const faces: { axis: ApperceptionAxis; pole: 'high' | 'low'; at: [number, number, number] }[] = [
    { axis: 'concrete', pole: 'high', at: [0.5, 1, 0.5] },
    { axis: 'concrete', pole: 'low', at: [0.5, 0, 0.5] },
    { axis: 'reflective', pole: 'high', at: [1, 0.5, 0.5] },
    { axis: 'reflective', pole: 'low', at: [0, 0.5, 0.5] },
    { axis: 'sequential', pole: 'high', at: [0.5, 0.5, 1] },
    { axis: 'sequential', pole: 'low', at: [0.5, 0.5, 0] },
  ];
  const labelEls = faces.map(({ axis, pole, at }) => {
    const [sx, sy] = project(at[0], at[1], at[2]);
    let dx = sx - ccx, dy = sy - ccy;
    const len = Math.hypot(dx, dy) || 1;
    const lx = sx + (dx / len) * 62, ly = sy + (dy / len) * 62;
    return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="${POLE_COLOR}" font-family="Albert Sans" font-size="25" font-weight="500" text-anchor="middle" dominant-baseline="middle">${POLES[axis][pole]}</text>`;
  }).join('');

  // ---- user point + dropline to the floor (y = 0) ----
  const [ux, uy] = project(px, py, pz);
  const [fx, fy] = project(px, 0, pz);
  const dropEl =
    `<line x1="${ux.toFixed(1)}" y1="${uy.toFixed(1)}" x2="${fx.toFixed(1)}" y2="${fy.toFixed(1)}" stroke="${DROP}" stroke-width="2.5" stroke-dasharray="4 6" />` +
    `<ellipse cx="${fx.toFixed(1)}" cy="${fy.toFixed(1)}" rx="9" ry="5" fill="${DROP}" fill-opacity="0.45" />`;
  const pointEl = `<circle cx="${ux.toFixed(1)}" cy="${uy.toFixed(1)}" r="16" fill="${ACCENT}" stroke="${BG}" stroke-width="4" />`;

  const badgeEl = opts?.badge
    ? `<text x="60" y="80" fill="${LABEL_COLOR}" font-family="Albert Sans" font-size="40" font-weight="700" text-anchor="start" letter-spacing="2">${opts.badge.toUpperCase()}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}" />
    ${badgeEl}
    ${edgeEls}
    ${dropEl}
    ${labelEls}
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
