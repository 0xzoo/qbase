// values — radar "shape" PNG renderer for the result snap.
//
// Generates a 1200×900 (4:3) PNG of the user's 5-dim radar polygon, suitable
// as the hero image on the values result snap. Resvg-wasm rasterizes a pure
// SVG string we build server-side, so the geometry is independent of the
// React renderer in src/pages/ValuesResult.tsx (kept deliberately close to
// it so the snap and miniapp read the same).

import type { ValuesAxis } from './questions';
import type { ValuesScore } from './scoring';

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

let fontBuffers: Uint8Array[] | null = null;
async function ensureFonts(assets: { fetch: (r: Request | string) => Promise<Response> }): Promise<void> {
  if (fontBuffers) return;
  const paths = [
    '/fonts/AlbertSans/AlbertSans-Bold.ttf',
    '/fonts/AlbertSans/AlbertSans-Medium.ttf',
    '/fonts/AlbertSans/AlbertSans-Regular.ttf',
  ];
  fontBuffers = [];
  for (const p of paths) {
    try {
      const res = await assets.fetch(new Request(`https://dummy${p}`));
      if (res.ok) {
        fontBuffers.push(new Uint8Array(await res.arrayBuffer()));
      }
    } catch (e) {
      console.error(`[values shape] font load failed for ${p}:`, e);
    }
  }
}

// Matches src/pages/ValuesResult.tsx — clockwise from 12 o'clock so the
// self-direction dims sit on opposite sides of the vertical axis.
const SPOKE_ORDER: readonly ValuesAxis[] = [
  'autonomy',
  'openness',
  'mastery',
  'universalism',
  'care',
];

const DIM_LABEL: Record<ValuesAxis, string> = {
  autonomy: 'autonomy',
  care: 'care',
  openness: 'openness',
  mastery: 'mastery',
  universalism: 'universalism',
};

const WIDTH = 1200;
const HEIGHT = 900;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const MAX_R = Math.min(WIDTH, HEIGHT) * 0.34;
const LABEL_R = Math.min(WIDTH, HEIGHT) * 0.42;

// qbase ocean blue (light theme accent). Picked to read on the cream R2
// asset backdrop the snap host will composite.
const ACCENT = '#0ea5e9';
const ACCENT_FILL = '#0ea5e9';
const ACCENT_FILL_OPACITY = 0.22;
const RING = '#cbd5e1';
const RING_STRONG = '#94a3b8';
const SPOKE = '#cbd5e1';
const LABEL_COLOR = '#475569';

function point(angleDeg: number, scale: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + MAX_R * scale * Math.sin(rad), CY - MAX_R * scale * Math.cos(rad)];
}

function labelPos(angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + LABEL_R * Math.sin(rad), CY - LABEL_R * Math.cos(rad)];
}

function angleFor(dim: ValuesAxis): number {
  return (SPOKE_ORDER.indexOf(dim) * 360) / SPOKE_ORDER.length;
}

function polyString(pts: [number, number][]): string {
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

export function buildShapeSvg(scores: ValuesScore, opts?: { badge?: string }): string {
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

  const labelEls = SPOKE_ORDER.map((d) => {
    const [x, y] = labelPos(angleFor(d));
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(
      1,
    )}" fill="${LABEL_COLOR}" font-family="Albert Sans" font-size="30" font-weight="500" text-anchor="middle" dominant-baseline="middle">${DIM_LABEL[d]}</text>`;
  }).join('');

  // Badge anchored to the upper-left so it doesn't collide with the
  // 12-o'clock "autonomy" dim label.
  const badgeEl = opts?.badge
    ? `<text x="60" y="80" fill="${LABEL_COLOR}" font-family="Albert Sans" font-size="40" font-weight="700" text-anchor="start" letter-spacing="2">${opts.badge.toUpperCase()}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#FDFBF7" />
    ${badgeEl}
    ${ringEls}
    ${spokeEls}
    <polygon points="${polyString(
      scorePoly,
    )}" fill="${ACCENT_FILL}" fill-opacity="${ACCENT_FILL_OPACITY}" stroke="${ACCENT}" stroke-width="3" stroke-linejoin="round" />
    ${labelEls}
    <text x="${CX}" y="${HEIGHT - 50}" fill="${LABEL_COLOR}" font-family="Albert Sans" font-size="26" font-weight="500" text-anchor="middle">values · by @qbase</text>
  </svg>`;
}

export async function renderShapePng(
  env: Env,
  scores: ValuesScore,
  opts?: { badge?: string },
): Promise<Uint8Array> {
  await ensureFonts(env.ASSETS);
  const svg = buildShapeSvg(scores, opts);
  const Resvg = await loadResvg();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      fontBuffers: fontBuffers ?? [],
      loadSystemFonts: false,
      defaultFontFamily: 'Albert Sans',
    },
  });
  return resvg.render().asPng();
}
