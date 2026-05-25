// apperception — radar "shape" PNG renderer for the result snap.
//
// Generates a 1200×900 (4:3) PNG of the user's 3-dim apperception
// triangle, suitable as the hero image on the result snap. Resvg-wasm
// rasterizes an SVG we build server-side.
//
// Three vertices form an equilateral triangle:
//   concrete   — 12 o'clock (example-first ↔ principle-first)
//   reflective — 4 o'clock (think-first ↔ learn-by-doing)
//   sequential — 8 o'clock (step-by-step ↔ big-picture-first)

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

// Clockwise: concrete (12h), reflective (4h), sequential (8h).
const SPOKE_ORDER: readonly ApperceptionAxis[] = [
  'concrete',
  'reflective',
  'sequential',
];

const DIM_LABEL: Record<ApperceptionAxis, string> = {
  concrete: 'concrete',
  reflective: 'reflective',
  sequential: 'sequential',
};

// Pole labels shown inside each vertex to anchor the viewer.
const POLE_LABEL: Record<ApperceptionAxis, { high: string; low: string }> = {
  concrete: { high: 'example-first', low: 'principle-first' },
  reflective: { high: 'think-first', low: 'learn-by-doing' },
  sequential: { high: 'step-by-step', low: 'big-picture' },
};

const WIDTH = 1200;
const HEIGHT = 900;
const CX = WIDTH / 2;
const CY = HEIGHT / 2 - 20; // slight upward bias so footer has room
const MAX_R = Math.min(WIDTH, HEIGHT) * 0.30;
const LABEL_R = Math.min(WIDTH, HEIGHT) * 0.42;

// ─── Colour palette: purple/blue — cool, introspective ───────────────
const BG = '#FDFBF7';           // cream (shared with values)
const ACCENT = '#7C3AED';       // violet-600
const ACCENT_FILL = '#7C3AED';
const ACCENT_FILL_OPACITY = 0.20;
const RING = '#C4B5FD';         // violet-300
const RING_STRONG = '#8B5CF6';  // violet-500
const SPOKE = '#C4B5FD';
const LABEL_COLOR = '#475569';
const POLE_COLOR = '#64748B';
const FOOTER_COLOR = '#94A3B8';

function point(angleDeg: number, scale: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + MAX_R * scale * Math.sin(rad), CY - MAX_R * scale * Math.cos(rad)];
}

function labelPos(angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + LABEL_R * Math.sin(rad), CY - LABEL_R * Math.cos(rad)];
}

function angleFor(dim: ApperceptionAxis): number {
  return (SPOKE_ORDER.indexOf(dim) * 360) / SPOKE_ORDER.length;
}

function polyString(pts: [number, number][]): string {
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

export function buildShapeSvg(
  scores: ApperceptionScore,
  opts?: { badge?: string },
): string {
  const rings = [0.25, 0.5, 0.75, 1.0].map((r) =>
    SPOKE_ORDER.map((d) => point(angleFor(d), r)),
  );
  const scorePoly = SPOKE_ORDER.map((d) => point(angleFor(d), scores[d]));

  const ringEls = rings
    .map(
      (pts, i) =>
        `<polygon points="${polyString(pts)}" fill="none" stroke="${
          i === 3 ? RING_STRONG : RING
        }" stroke-width="${i === 3 ? 2 : 1}" />`,
    )
    .join('');

  const spokeEls = SPOKE_ORDER.map((d) => {
    const [x, y] = point(angleFor(d), 1);
    return `<line x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(
      1,
    )}" stroke="${SPOKE}" stroke-width="1" />`;
  }).join('');

  // Dim labels at vertices
  const labelEls = SPOKE_ORDER.map((d) => {
    const [x, y] = labelPos(angleFor(d));
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(
      1,
    )}" fill="${LABEL_COLOR}" font-family="Albert Sans" font-size="36" font-weight="600" text-anchor="middle" dominant-baseline="middle">${DIM_LABEL[d]}</text>`;
  }).join('');

  // Pole markers — tiny labels at the innermost ring showing both poles
  const poleEls = SPOKE_ORDER.map((d) => {
    const a = angleFor(d);
    const pl = POLE_LABEL[d];
    // High pole (outer end)
    const [hx, hy] = point(a, 0.95);
    // Low pole (center end) — just slightly out from center
    const [lx, ly] = point(a, 0.4);

    // High-pole label
    const high = `<text x="${hx.toFixed(1)}" y="${(hy - 12).toFixed(
      1,
    )}" fill="${POLE_COLOR}" font-family="Albert Sans" font-size="22" font-weight="500" text-anchor="middle" dominant-baseline="alphabetic">${pl.high}</text>`;
    // Center marker (0.5 tick)
    const [cx2, cy2] = point(a, 0.48);
    const tick = `<circle cx="${cx2.toFixed(1)}" cy="${cy2.toFixed(
      1,
    )}" r="4" fill="${SPOKE}" />`;
    // Low-pole label
    const low = `<text x="${lx.toFixed(1)}" y="${(ly + 20).toFixed(
      1,
    )}" fill="${POLE_COLOR}" font-family="Albert Sans" font-size="20" font-weight="400" text-anchor="middle" dominant-baseline="hanging">${pl.low}</text>`;
    return high + tick + low;
  }).join('');

  // Badge anchored upper-left
  const badgeEl = opts?.badge
    ? `<text x="60" y="80" fill="${LABEL_COLOR}" font-family="Albert Sans" font-size="40" font-weight="700" text-anchor="start" letter-spacing="2">${opts.badge.toUpperCase()}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}" />
    ${badgeEl}
    ${ringEls}
    ${spokeEls}
    ${poleEls}
    <polygon points="${polyString(
      scorePoly,
    )}" fill="${ACCENT_FILL}" fill-opacity="${ACCENT_FILL_OPACITY}" stroke="${ACCENT}" stroke-width="3" stroke-linejoin="round" />
    ${labelEls}
    <text x="${CX}" y="${HEIGHT - 44}" fill="${FOOTER_COLOR}" font-family="Albert Sans" font-size="26" font-weight="500" text-anchor="middle">app·erception · by @qbase</text>
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
