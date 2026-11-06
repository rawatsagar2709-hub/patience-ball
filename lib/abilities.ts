/** Abilities: four helpers you earn from weekly tasks and spend inside a level. Stored per browser. */
import { weekKey } from './daily';

export type AbilityKey = 'extra' | 'home' | 'freeze' | 'slow';
export type TaskKind = 'balls' | 'wins' | 'stars3' | 'combo';

export const ABILITIES: Record<AbilityKey, { name: string; text: string }> = {
  extra: { name: 'Extra balls', text: 'Drops three extra balls onto the board.' },
  home: { name: 'Home run', text: 'One ball you still need goes straight into its hole.' },
  freeze: { name: 'Freeze', text: 'Moving obstacles and doors stop for 8 seconds.' },
  slow: { name: 'Slow time', text: 'Everything moves at half speed for 8 seconds.' },
};

/** Each weekly task pays one charge of one ability. */
export const TASKS: Array<{ kind: TaskKind; goal: number; label: string; reward: AbilityKey }> = [
  { kind: 'balls', goal: 150, label: 'Sink 150 balls', reward: 'extra' },
  { kind: 'wins', goal: 10, label: 'Win 10 levels', reward: 'home' },
  { kind: 'stars3', goal: 3, label: 'Get 3 stars on 3 levels', reward: 'freeze' },
  { kind: 'combo', goal: 8, label: 'Land 8 combos', reward: 'slow' },
];

interface Store { week: string; prog: number[]; stock: Record<AbilityKey, number> }
const KEY = 'pb_abilities';
const MAX = 5;
const empty = (): Store => ({ week: weekKey(), prog: TASKS.map(() => 0), stock: { extra: 0, home: 0, freeze: 0, slow: 0 } });

export function readAbilities(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && v.stock && Array.isArray(v.prog)) {
      const s: Store = { week: String(v.week), prog: TASKS.map((_, i) => Math.max(0, Number(v.prog[i]) || 0)), stock: { extra: 0, home: 0, freeze: 0, slow: 0, ...v.stock } };
      if (s.week !== weekKey()) { s.week = weekKey(); s.prog = TASKS.map(() => 0); } // tasks reset every week, charges are kept
      return s;
    }
  } catch { /* storage unavailable */ }
  return empty();
}
const write = (s: Store) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } };

/** Add progress. Returns the abilities earned by it (one per task that just reached its goal). */
export function bumpTask(kind: TaskKind, n = 1): AbilityKey[] {
  const s = readAbilities();
  const won: AbilityKey[] = [];
  TASKS.forEach((t, i) => {
    if (t.kind !== kind || s.prog[i] >= t.goal) return;
    s.prog[i] = Math.min(t.goal, s.prog[i] + n);
    if (s.prog[i] >= t.goal) { s.stock[t.reward] = Math.min(MAX, s.stock[t.reward] + 1); won.push(t.reward); }
  });
  write(s);
  return won;
}

/** Spend one charge. Returns false when there is none. */
export function spendAbility(key: AbilityKey): boolean {
  const s = readAbilities();
  if (s.stock[key] <= 0) return false;
  s.stock[key]--;
  write(s);
  return true;
}

/** One-time bonus: +1 of every ability (capped). Returns false if it was already claimed on this device. */
export function claimSecret(): boolean {
  try {
    if (localStorage.getItem('pb_secret')) return false;
    localStorage.setItem('pb_secret', '1');
  } catch { return false; }
  const s = readAbilities();
  (Object.keys(s.stock) as AbilityKey[]).forEach((k) => { s.stock[k] = Math.min(MAX, s.stock[k] + 1); });
  write(s);
  return true;
}
