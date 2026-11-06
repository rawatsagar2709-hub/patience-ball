import { describe, expect, it } from 'vitest';
import { generateLevel } from '@/lib/levels/levelGenerator';

const goalFloors = (n: number, seed: number) => {
  const l = generateLevel(n, seed);
  return new Set(l.trays.map((t, i) => (t.holes.some((h) => h.kind === 'goal') ? i : -1)).filter((i) => i >= 0));
};

describe('goal holes by level', () => {
  it('sit on a single floor for levels 1-20', () => {
    for (let n = 1; n <= 20; n++) for (let s = 1; s <= 5; s++) expect(goalFloors(n, s).size).toBe(1);
  });
  it('spread over several floors for some levels after 20', () => {
    let spread = false;
    for (let n = 22; n <= 40; n++) for (let s = 1; s <= 3; s++) if (goalFloors(n, s).size > 1) spread = true;
    expect(spread).toBe(true);
  });
});
