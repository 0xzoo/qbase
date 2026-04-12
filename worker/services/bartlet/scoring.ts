// bartlet — scoring, archetype/hybrid detection, narratives.
// Ported from docs/quizzes/bartlet/v2-quiz.ts with identifier renames and the
// qbase Query dep removed. Scorer is unchanged on purpose: detectDiagonalHybrid
// in particular is hard-won; see SPEC §3.

import { bartletQuestions } from './questions';

export type Archetype = 'Achiever' | 'Explorer' | 'Killer' | 'Socializer';

export type HybridArchetype =
  | 'Speedrunner' // Explorer × Achiever
  | 'Agitator'    // Killer × Socializer
  | 'Strategist'  // Killer × Explorer (diagonal)
  | 'Host'        // Socializer × Explorer
  | 'Influencer'  // Achiever × Socializer (diagonal)
  | 'Gladiator';  // Achiever × Killer

export interface BartletAnswer {
  queryId: string;
  optionIndex: number;
}

export interface BartletScore {
  orientation: number;
  engagement: number;
  confidence: number;
  archetype: Archetype;
  hybrid: HybridArchetype | null;
  pureness: number;
}

export interface FreeTierResult {
  dominant: Archetype;
  runnerUp: Archetype;
  summary: string;
  signatureAnswers: string[];
  blindSpot: string;
  // If set, the user reads as a blend of two quadrants. We use this for the
  // image slug + badge label so the reveal can show e.g. "SPEEDRUNNER" instead
  // of just "EXPLORER". Signature answers still come from the dominant quadrant.
  hybrid: HybridArchetype | null;
  // The label shown on the badge and used as the image filename slug
  // (lowercased). Equals the hybrid when set, otherwise the dominant.
  displayLabel: string;
}

export interface QuadrantDistribution {
  Achiever: number;
  Explorer: number;
  Killer: number;
  Socializer: number;
}

export interface PaidTierResult extends FreeTierResult {
  orientation: number;
  engagement: number;
  confidence: number;
  hybridLabel: string;
  hybridEvidence: string;
  axisNarratives: { orientation: string; engagement: string };
  quadrantDistribution: QuadrantDistribution;
  recommendations: string[];
}

export function scoreBartlet(answers: BartletAnswer[]): BartletScore {
  const byId = new Map(bartletQuestions.map((q) => [q.id, q]));

  let orientationSum = 0, orientationCount = 0;
  let engagementSum = 0, engagementCount = 0;

  for (const ans of answers) {
    const query = byId.get(ans.queryId);
    if (!query) continue;
    const option = query.a_options[ans.optionIndex];
    if (!option) continue;
    const w = option.weights;
    if (typeof w.orientation === 'number') {
      orientationSum += w.orientation;
      orientationCount++;
    }
    if (typeof w.engagement === 'number') {
      engagementSum += w.engagement;
      engagementCount++;
    }
  }

  const orientation = orientationCount ? orientationSum / orientationCount : 0;
  const engagement = engagementCount ? engagementSum / engagementCount : 0;

  const sampleConf =
    (Math.min(orientationCount, 8) + Math.min(engagementCount, 8)) / 16;
  const magnitudeConf = Math.min(1, Math.hypot(orientation, engagement) / 0.6);
  const confidence = 0.6 * sampleConf + 0.4 * magnitudeConf;

  const archetype = quadrantFor(orientation, engagement);
  const hybrid = axisHybridFor(orientation, engagement);
  const pureness = Math.min(Math.abs(orientation), Math.abs(engagement));

  return { orientation, engagement, confidence, archetype, hybrid, pureness };
}

function quadrantFor(x: number, y: number): Archetype {
  if (x >= 0 && y >= 0) return 'Achiever';
  if (x >= 0 && y < 0) return 'Explorer';
  if (x < 0 && y >= 0) return 'Killer';
  return 'Socializer';
}

function axisHybridFor(x: number, y: number): HybridArchetype | null {
  const threshold = 0.25;
  const onOrientationAxis = Math.abs(x) < threshold && Math.abs(y) >= threshold;
  const onEngagementAxis = Math.abs(y) < threshold && Math.abs(x) >= threshold;
  if (!onOrientationAxis && !onEngagementAxis) return null;

  if (onOrientationAxis) {
    return y >= 0 ? 'Gladiator' : 'Host';
  }
  return x >= 0 ? 'Speedrunner' : 'Agitator';
}

// ---------- Free tier ----------

export function freeTierResult(answers: BartletAnswer[]): FreeTierResult {
  const tallies = quadrantTallies(answers);
  const ranked = (Object.keys(tallies) as Archetype[]).sort(
    (a, b) => tallies[b] - tallies[a]
  );
  const dominant = ranked[0];

  // Hybrid resolution: diagonal beats axis when it's confident enough,
  // matching the SPEC §3 priority (diagonal is a stronger claim).
  const score = scoreBartlet(answers);
  const dist = quadrantDistribution(answers);
  const diagonal = detectDiagonalHybrid(dist, score);
  const hybrid: HybridArchetype | null =
    diagonal && diagonal.confidence > 0.35 ? diagonal.label : score.hybrid;

  const summary = hybrid
    ? hybridNarratives[hybrid].summary
    : archetypeNarratives[dominant].summary;
  const blindSpot = hybrid
    ? hybridNarratives[hybrid].blindSpot
    : archetypeNarratives[dominant].blindSpot;
  const displayLabel = hybrid ?? dominant;

  return {
    dominant,
    runnerUp: ranked[1],
    summary,
    signatureAnswers: pickSignatureAnswers(answers, dominant),
    blindSpot,
    hybrid,
    displayLabel,
  };
}

// ---------- Diagonal hybrid detection (paid tier feature, but keep here) ----

export function quadrantDistribution(answers: BartletAnswer[]): QuadrantDistribution {
  const raw = quadrantTallies(answers);
  const total = raw.Achiever + raw.Explorer + raw.Killer + raw.Socializer;
  if (total === 0) return { Achiever: 0, Explorer: 0, Killer: 0, Socializer: 0 };
  return {
    Achiever: raw.Achiever / total,
    Explorer: raw.Explorer / total,
    Killer: raw.Killer / total,
    Socializer: raw.Socializer / total,
  };
}

export interface DiagonalHybridDetection {
  label: HybridArchetype;
  confidence: number;
  evidence: string;
}

export function detectDiagonalHybrid(
  dist: QuadrantDistribution,
  score: BartletScore
): DiagonalHybridDetection | null {
  const { Achiever: A, Explorer: E, Killer: K, Socializer: S } = dist;

  const strategistRaw = Math.min(K, E) - Math.max(A, S);
  const influencerRaw = Math.min(A, S) - Math.max(K, E);

  const best = strategistRaw > influencerRaw
    ? { label: 'Strategist' as HybridArchetype, raw: strategistRaw, a: K, b: E, poleA: 'Killer', poleB: 'Explorer' }
    : { label: 'Influencer' as HybridArchetype, raw: influencerRaw, a: A, b: S, poleA: 'Achiever', poleB: 'Socializer' };

  if (best.raw <= 0) return null;

  const magnitude = Math.hypot(score.orientation, score.engagement);
  const nearOriginBonus = Math.max(0, 1 - magnitude / 0.6);
  const balance =
    Math.max(best.a, best.b) > 0 ? Math.min(best.a, best.b) / Math.max(best.a, best.b) : 0;

  const confidence = clamp01(
    0.55 * clamp01(best.raw * 2.5) + 0.25 * balance + 0.2 * nearOriginBonus
  );

  if (confidence < 0.25) return null;

  const pctA = Math.round(best.a * 100);
  const pctB = Math.round(best.b * 100);
  const evidence =
    `${pctA}% of your weighted answers land in ${best.poleA} and ${pctB}% in ${best.poleB}, ` +
    `with the other two quadrants nearly empty — that's the signature of a ${best.label}.`;

  return { label: best.label, confidence, evidence };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function quadrantTallies(answers: BartletAnswer[]): Record<Archetype, number> {
  const byId = new Map(bartletQuestions.map((q) => [q.id, q]));
  const t: Record<Archetype, number> = { Achiever: 0, Explorer: 0, Killer: 0, Socializer: 0 };
  for (const ans of answers) {
    const q = byId.get(ans.queryId);
    const opt = q?.a_options[ans.optionIndex];
    if (!opt) continue;
    const x = opt.weights.orientation ?? 0;
    const y = opt.weights.engagement ?? 0;
    const weight = Math.hypot(x, y);
    if (weight === 0) continue;
    t[quadrantFor(x, y)] += weight;
  }
  return t;
}

function pickSignatureAnswers(answers: BartletAnswer[], type: Archetype): string[] {
  const byId = new Map(bartletQuestions.map((q) => [q.id, q]));
  const hits: Array<{ stem: string; label: string; score: number }> = [];
  for (const ans of answers) {
    const q = byId.get(ans.queryId);
    if (!q) continue;
    const opt = q.a_options[ans.optionIndex];
    if (!opt) continue;
    const x = opt.weights.orientation ?? 0;
    const y = opt.weights.engagement ?? 0;
    if (Math.hypot(x, y) === 0) continue;
    if (quadrantFor(x, y) !== type) continue;
    hits.push({ stem: q.stem, label: opt.label, score: Math.hypot(x, y) });
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((h) => `you picked "${h.label}" on "${h.stem}"`);
}

// ---------- Paid tier ----------

export function paidTierResult(answers: BartletAnswer[]): PaidTierResult {
  const base = freeTierResult(answers);
  const score = scoreBartlet(answers);
  const dist = quadrantDistribution(answers);
  const diagonal = detectDiagonalHybrid(dist, score);

  // Hybrid label & evidence
  let hybridLabel: string;
  let hybridEvidence: string;
  if (base.hybrid) {
    const hn = hybridNarratives[base.hybrid];
    hybridLabel = `${base.dominant} × ${base.runnerUp} (${base.hybrid})`;
    hybridEvidence = diagonal
      ? diagonal.evidence
      : `Your top two quadrants are ${base.dominant} and ${base.runnerUp}, blending into the ${base.hybrid} archetype.`;
    // Use the hybrid summary if available
    void hn;
  } else {
    hybridLabel = base.dominant;
    hybridEvidence = `You're a clear ${base.dominant} — no strong secondary signal.`;
  }

  // Axis narratives
  const orientationNarrative =
    score.orientation > 0.25
      ? 'You lean toward World (systems, environment).'
      : score.orientation < -0.25
        ? 'You lean toward Players (people, competition).'
        : 'You sit on the boundary between Players and World.';
  const engagementNarrative =
    score.engagement > 0.25
      ? 'You lean toward Acting (direct action, impact).'
      : score.engagement < -0.25
        ? 'You lean toward Interacting (observation, exploration).'
        : 'You sit on the boundary between Acting and Interacting.';

  // Personalized recommendations
  const recommendations = buildRecommendations(base.dominant, base.hybrid);

  return {
    ...base,
    orientation: score.orientation,
    engagement: score.engagement,
    confidence: score.confidence,
    hybridLabel,
    hybridEvidence,
    axisNarratives: {
      orientation: orientationNarrative,
      engagement: engagementNarrative,
    },
    quadrantDistribution: dist,
    recommendations,
  };
}

function buildRecommendations(
  dominant: Archetype,
  hybrid: HybridArchetype | null
): string[] {
  const recs: Record<Archetype, string[]> = {
    Achiever: [
      'Set a personal goal that has no leaderboard — practice doing things that only you measure.',
      'Mentor someone newer; teaching compounds your expertise without needing a scoreboard.',
      'Try an exploration session with no KPIs — wander the protocol for its own sake.',
    ],
    Explorer: [
      'Ship something small from your discoveries — understanding gains value when it moves.',
      'Pair with an Achiever to turn your insights into measurable outcomes.',
      'Write up one obscure finding per week; your map-making helps the whole community.',
    ],
    Killer: [
      'Pick one debate and steelman the other side before engaging — sharpen through empathy.',
      'Channel competitive energy into a collaborative project; rivals make great co-founders.',
      'Notice when friction stops being productive — the best fighters know when to disengage.',
    ],
    Socializer: [
      'Reach out to someone outside your usual circle this week — expand the graph.',
      'Turn one conversation into a concrete artifact (a post, a doc, a proposal).',
      'Partner with a Killer or Achiever on a project — your people skills amplify their drive.',
    ],
  };

  const base = recs[dominant];
  if (hybrid) {
    // Add a hybrid-specific recommendation
    const hybridRec: Record<HybridArchetype, string> = {
      Speedrunner: 'Balance speed with depth — sometimes the scenic route reveals shortcuts the meta hasn\'t found.',
      Agitator: 'Channel your provocative energy into questions, not just challenges — the best agitators make people think.',
      Gladiator: 'Let some wins stay quiet — not every achievement needs an audience to count.',
      Host: 'Track your contributions the way others track metrics — your infrastructure deserves visibility.',
      Strategist: 'Remember that the strongest position includes allies, not just information.',
      Influencer: 'Check in on whether your connections are mutual or performative — depth beats reach.',
    };
    return [...base, hybridRec[hybrid]];
  }
  return base;
}

export const hybridNarratives: Record<
  HybridArchetype,
  { summary: string; blindSpot: string }
> = {
  Speedrunner: {
    summary:
      "you learn systems fast and turn that understanding into visible wins. you are the first to figure out a new feature and the first on its leaderboard.",
    blindSpot:
      "you optimize for whatever the current meta rewards — when the meta shifts you can feel briefly lost.",
  },
  Agitator: {
    summary:
      "you bring the heat, but you want an audience for it. the fight is only fun if people are watching and talking.",
    blindSpot:
      "you need people to engage for the energy to land — when the room ignores you, you escalate.",
  },
  Gladiator: {
    summary:
      "you play to win and you want everyone to see it. leaderboards, ratios, victory laps — the scoreboard and the fight are the same thing.",
    blindSpot:
      "every interaction becomes a performance. quiet wins feel like they didn't count.",
  },
  Host: {
    summary:
      "you curate spaces and share what you find. the channel you built, the thread you started, the fren you onboarded — your influence is infrastructural.",
    blindSpot:
      "you undercount your own work because it doesn't show up on any leaderboard.",
  },
  Strategist: {
    summary:
      "you study the system to gain leverage over other players. you read every doc AND you know every rival — the two halves reinforce each other.",
    blindSpot:
      "the game can become more interesting than the people in it. you can win positions that cost you the room.",
  },
  Influencer: {
    summary:
      "you build reputation through relationships, not metrics — but the reputation still matters. your follower graph is a friend graph, and both are how you keep score.",
    blindSpot:
      "the line between genuine connection and audience management gets blurry. sometimes you're not sure which one you're doing.",
  },
};

export const archetypeNarratives: Record<
  Archetype,
  { summary: string; blindSpot: string; symbol: string }
> = {
  Achiever: {
    symbol: '♦',
    summary:
      "you're driven by visible, measurable wins inside the system. leaderboards, follower count, rewards rank — these are how you keep score, and the scoring is the fun.",
    blindSpot:
      "you can conflate the metric with the goal. when the algo changes, so does your behavior — ask whether you'd still do it if no one was counting.",
  },
  Explorer: {
    symbol: '♠',
    summary:
      "you're here to figure out how it all works. new features, obscure mechanics, hidden corners of the protocol — if there's a system, you want to map it.",
    blindSpot:
      'you can mistake understanding for impact. knowing every flag on the api doesn\'t move anything unless you ship.',
  },
  Killer: {
    symbol: '♣',
    summary:
      'you want friction. debates, ratios, competitive trading — you get your energy from engagement where someone else has skin in the game.',
    blindSpot:
      'the line between productive challenge and just being mean is narrower than it feels from the inside. people remember.',
  },
  Socializer: {
    symbol: '♥',
    summary:
      "you're here for the people. the platform is the venue, the conversation is the event. deep replies, small channels, frens > followers.",
    blindSpot:
      'you can stay in comfortable circles and miss the people outside your existing graph. your world gets small if you only tend it.',
  },
};
