/**
 * values — the five dimensions as the client knows them: labels and the
 * radar's spoke order. Shared by ValuesRadar, ValuesResult and ValuesCompare
 * (kept out of the component file so fast refresh stays happy).
 */

export type ValuesAxis = 'autonomy' | 'care' | 'openness' | 'mastery' | 'universalism';

export type ValuesDimScores = Record<ValuesAxis, number>;

export const DIM_LABEL: Record<ValuesAxis, string> = {
  autonomy: 'Autonomy',
  care: 'Care',
  openness: 'Openness',
  mastery: 'Mastery',
  universalism: 'Universalism',
};

// Spoke order, clockwise from 12 o'clock. Positions chosen so the two
// "self-direction" dims (Autonomy + Mastery) sit on opposite sides of the
// center axis — the radar reads as left-half/right-half intuitively.
export const SPOKE_ORDER: ValuesAxis[] = [
  'autonomy',     //   0°  (top)
  'openness',     //  72°  (top-right)
  'mastery',      // 144°  (bottom-right)
  'universalism', // 216°  (bottom-left)
  'care',         // 288°  (top-left)
];
