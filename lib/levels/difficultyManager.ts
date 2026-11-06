export interface Difficulty {
  tier: 'normal' | 'hard' | 'boss';
  /** Most obstacles one tray may get. */
  obstacles: number;
  /** 0 (easy) .. 1 (hard), saturates around level 40. */
  d: number;
  traysMin: number;
  traysMax: number;
  /** How many distinct ball sizes a level may use. */
  classesMax: number;
  balls: number;
  /** Every 7th normal level has no red holes at all: a palate cleanser. */
  relaxed: boolean;
  trapsMin: number;
  trapsMax: number;
  /** Fraction of balls the player may lose to traps. */
  lossFrac: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function getDifficulty(level: number): Difficulty {
  const L = Math.max(1, Math.floor(level));
  const d = clamp((L - 1) / 60, 0, 1);
  // Every 5th level is a hard level, every 10th a boss level.
  const tier = L % 10 === 0 ? 'boss' : L % 5 === 0 ? 'hard' : 'normal';
  const easy = L <= 30; // the first three worlds are meant to be easy
  const bump = easy ? (tier === 'boss' ? 1 : 0) : tier === 'boss' ? 2 : tier === 'hard' ? 1 : 0;
  return {
    d,
    tier,
    // The level after a boss is a breather: half the obstacles and a single red hole.
    obstacles: (() => { const o = clamp((easy ? Math.floor(L / 8) : Math.floor((L + 1) / 4) - 6) + bump, 0, 6); return L > 1 && L % 10 === 1 ? Math.floor(o / 2) : o; })(),
    traysMin: easy ? 2 : clamp(3 + Math.floor((L - 31) / 10) + (tier === 'boss' ? 1 : 0), 3, 5),
    traysMax: easy ? clamp(2 + Math.floor((L - 1) / 7), 2, 4) : clamp(4 + Math.floor((L - 31) / 6) + (tier === 'boss' ? 1 : 0), 4, 6),
    classesMax: L < 8 ? 1 : L <= 30 ? 2 : 3, // gentle opening: a single ball size for the first 7 levels
    balls: easy ? clamp(10 + Math.floor(L / 2) + bump * 2, 10, 22) : clamp(Math.round(18 + (L - 30) * 0.7) + bump * 3, 18, 46),
    relaxed: L >= 7 && L % 7 === 0 && tier === 'normal',
    trapsMin: L >= 7 && L % 7 === 0 && tier === 'normal' ? 0 : 1 + Math.floor((L - 1) / 15),
    trapsMax: L >= 7 && L % 7 === 0 && tier === 'normal' ? 0 : L > 1 && L % 10 === 1 ? 1 : easy ? (L < 6 ? 1 : 2) : clamp(2 + Math.floor((L - 31) / 6) + (tier === 'normal' ? 0 : 1), 2, 6),
    lossFrac: easy ? (tier === 'boss' ? 0.4 : 0.5) : lerp(0.48, 0.2, clamp((L - 30) / 40, 0, 1)) * (tier === 'boss' ? 0.6 : tier === 'hard' ? 0.8 : 1),
  };
}
