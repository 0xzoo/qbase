// apperception — "shape" PNG renderer for the result snap.
//
// 1200×900 (4:3) hero. Two panels:
//   left  — a 3-axis cube (fixed isometric), the user as a point inside; the
//           8 corners are the 8 styles. Axes labeled with dimension names.
//   right — three diverging meters, one per bipolar dimension: neutral in the
//           middle, the fill leaning toward whichever pole, poles labeled.
// Resvg-wasm rasterizes the SVG we build server-side.

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

// Memoize the *promise* (not the array) so concurrent cold requests await one
// fully-populated result; assigning an empty array up front let a second
// request render with no fonts → resvg threw "Render failed".
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
        // Retry: the ASSETS binding can be cold/not-ready on an isolate's first
        // request, which previously surfaced as a 500 on the first shape render.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await assets.fetch(new Request(`https://dummy${p}`));
            if (res.ok) { buffers.push(new Uint8Array(await res.arrayBuffer())); break; }
            console.error(`[apperception shape] font ${p} -> HTTP ${res.status} (attempt ${attempt + 1})`);
          } catch (e) {
            console.error(`[apperception shape] font ${p} fetch failed (attempt ${attempt + 1}):`, e);
          }
          await new Promise((r) => setTimeout(r, 60));
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
const ACCENT = '#7C3AED';      // violet-600
const FRAME = '#C4B5FD';       // violet-300 — faint cube + meter tracks
const TRACK = '#EDE7FB';       // very light meter track fill
const DIM_COLOR = '#475569';   // dimension names / badge
const POLE_COLOR = '#64748B';  // pole labels
const FOOTER_COLOR = '#94A3B8';

const POLES: Record<ApperceptionAxis, { high: string; low: string }> = {
  concrete: { high: 'example-first', low: 'principle-first' },
  reflective: { high: 'think-first', low: 'learn-by-doing' },
  sequential: { high: 'step-by-step', low: 'big-picture' },
};
const DIM_ORDER: ApperceptionAxis[] = ['concrete', 'reflective', 'sequential'];

const f = (n: number) => n.toFixed(1);

// ─── Left panel: isometric cube ──────────────────────────────────────
const YAW = (38 * Math.PI) / 180;
const PITCH = (20 * Math.PI) / 180;
const CUBE_OX = 330;
const CUBE_OY = HEIGHT / 2 + 20;
const CUBE_S = 215;

function project(x: number, y: number, z: number): [number, number, number] {
  const cx = x - 0.5, cy = y - 0.5, cz = z - 0.5;
  const x1 = cx * Math.cos(YAW) + cz * Math.sin(YAW);
  const z1 = -cx * Math.sin(YAW) + cz * Math.cos(YAW);
  const y2 = cy * Math.cos(PITCH) - z1 * Math.sin(PITCH);
  const z2 = cy * Math.sin(PITCH) + z1 * Math.cos(PITCH);
  return [CUBE_OX + x1 * CUBE_S, CUBE_OY - y2 * CUBE_S, z2];
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

function cubePanel(scores: ApperceptionScore): string {
  const px = scores.reflective, py = scores.concrete, pz = scores.sequential;

  // faint reference cube
  const pv = VERTS.map(([x, y, z]) => project(x, y, z));
  const frame = EDGES
    .map(([a, b]) => `<line x1="${f(pv[a][0])}" y1="${f(pv[a][1])}" x2="${f(pv[b][0])}" y2="${f(pv[b][1])}" stroke="${FRAME}" stroke-width="1.25" stroke-opacity="0.6" />`)
    .join('');

  // faint center axes — both poles symmetric about neutral (unlabeled; the
  // meters name every dimension/pole). Cross the cube centre.
  const axisPairs: [[number, number, number], [number, number, number]][] = [
    [[0.5, 0, 0.5], [0.5, 1, 0.5]],   // concrete (vertical)
    [[0, 0.5, 0.5], [1, 0.5, 0.5]],   // reflective
    [[0.5, 0.5, 0], [0.5, 0.5, 1]],   // sequential
  ];
  const axes = axisPairs.map(([lo, hi]) => {
    const [lx, ly] = project(lo[0], lo[1], lo[2]);
    const [hx, hy] = project(hi[0], hi[1], hi[2]);
    return `<line x1="${f(lx)}" y1="${f(ly)}" x2="${f(hx)}" y2="${f(hy)}" stroke="${ACCENT}" stroke-width="1.5" stroke-opacity="0.35" />`;
  }).join('');

  // bold lean vector: neutral centre → the user's point
  const [cx, cy] = project(0.5, 0.5, 0.5);
  const [ux, uy] = project(px, py, pz);
  const center = `<circle cx="${f(cx)}" cy="${f(cy)}" r="5" fill="${FRAME}" />`;
  const lean = `<line x1="${f(cx)}" y1="${f(cy)}" x2="${f(ux)}" y2="${f(uy)}" stroke="${ACCENT}" stroke-width="5" stroke-linecap="round" />`;
  return frame + axes + center + lean;
}

// ─── Right panel: three diverging meters ─────────────────────────────
function metersPanel(scores: ApperceptionScore): string {
  const barX = 690, barW = 410, barH = 18;
  const cxv = barX + barW / 2;            // neutral (0.5) center
  const top = 300, gap = 150;
  return DIM_ORDER.map((dim, i) => {
    const v = scores[dim];
    const my = top + i * gap;             // bar vertical center
    const markerX = barX + v * barW;
    const fillX = Math.min(cxv, markerX), fillW = Math.abs(markerX - cxv);
    const name = `<text x="${barX}" y="${my - 30}" fill="${DIM_COLOR}" font-family="Albert Sans" font-size="26" font-weight="700" text-anchor="start" dominant-baseline="middle">${dim}</text>`;
    const track = `<rect x="${barX}" y="${my - barH / 2}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${TRACK}" />`;
    const tick = `<line x1="${cxv}" y1="${my - barH / 2 - 6}" x2="${cxv}" y2="${my + barH / 2 + 6}" stroke="${FRAME}" stroke-width="2" />`;
    const fill = `<rect x="${f(fillX)}" y="${my - barH / 2}" width="${f(fillW)}" height="${barH}" rx="${barH / 2}" fill="${ACCENT}" fill-opacity="0.85" />`;
    const knob = `<circle cx="${f(markerX)}" cy="${my}" r="11" fill="${ACCENT}" stroke="${BG}" stroke-width="3" />`;
    const lo = `<text x="${barX}" y="${my + 36}" fill="${POLE_COLOR}" font-family="Albert Sans" font-size="20" font-weight="400" text-anchor="start" dominant-baseline="middle">${POLES[dim].low}</text>`;
    const hi = `<text x="${barX + barW}" y="${my + 36}" fill="${POLE_COLOR}" font-family="Albert Sans" font-size="20" font-weight="400" text-anchor="end" dominant-baseline="middle">${POLES[dim].high}</text>`;
    return name + track + tick + fill + knob + lo + hi;
  }).join('');
}

export function buildShapeSvg(
  scores: ApperceptionScore,
  opts?: { badge?: string },
): string {
  const badge = opts?.badge
    ? `<text x="60" y="80" fill="${DIM_COLOR}" font-family="Albert Sans" font-size="40" font-weight="700" text-anchor="start" letter-spacing="2">${opts.badge.toUpperCase()}</text>`
    : '';
  // dimension-name header at the top of the left (cube) panel
  const cubeHeader = `<text x="${CUBE_OX}" y="235" fill="${DIM_COLOR}" font-family="Albert Sans" font-size="24" font-weight="700" text-anchor="middle" dominant-baseline="middle">concrete · reflective · sequential</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}" />
    ${badge}
    ${cubeHeader}
    ${cubePanel(scores)}
    ${metersPanel(scores)}
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
  // Resvg.async() awaits wasm readiness — the sync `new Resvg()` throws
  // "Resvg is not yet ready" on a cold isolate's first render.
  const resvg = await Resvg.async(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      fontBuffers: fonts,
      loadSystemFonts: false,
      defaultFontFamily: 'Albert Sans',
    },
  });
  return resvg.render().asPng();
}
