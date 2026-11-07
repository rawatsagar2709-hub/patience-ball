import { describe, expect, it } from 'vitest';
import { generateLevel } from '@/lib/levels/levelGenerator';
import { loadRapier } from '@/lib/physics/physicsWorld';
import { Simulation } from '@/lib/physics/simulation';

describe('soak', () => {
  it('generates sound levels for levels 1-200 over several seeds', () => {
    const fallbacks: string[] = [];
    for (let n = 1; n <= 200; n++) for (let s = 1; s <= 4; s++) {
      const l = generateLevel(n, s * 977 + n);
      const cls = new Set(l.balls.map((b) => b.cls));
      for (const c of cls) expect(l.trays.some((t) => t.holes.some((h) => h.kind === 'goal' && h.cls === c)), `L${n} s${s} class ${c} has no goal`).toBe(true);
      expect(l.required).toBeGreaterThan(0);
      expect(l.required + l.allowedLoss).toBeLessThanOrEqual(l.balls.length);
      l.classNeed.forEach((need, c) => expect(need, `L${n} class ${c} needs more than exist`).toBeLessThanOrEqual(l.balls.filter((b) => b.cls === c).length));
      if (l.fallback) fallbacks.push(`L${n}s${s}`);
    }
    console.log('fallback levels:', fallbacks.length, fallbacks.slice(0, 12).join(' '));
  });

  it('survives random play and every ability at random moments without NaN or a wrong end state', async () => {
    const R = await loadRapier();
    let seedN = 5;
    const rnd = () => { seedN = (seedN * 1664525 + 1013904223) % 4294967296; return seedN / 4294967296; };
    for (const n of [1, 5, 12, 25, 30, 44, 80]) {
      const base = generateLevel(n, n * 31);
      const extra = Array.from({ length: 3 }, () => ({ ...base.balls[0] }));
      const sim = new Simulation(R, { ...base, balls: [...base.balls, ...extra], reserve: 3 });
      let ended = '';
      for (let i = 0; i < 60 * 40; i++) {
        if (i % 20 === 0) sim.setInput(rnd() * 2 - 1, rnd() * 2 - 1);
        const roll = rnd();
        if (roll < 0.002) sim.addReserve();
        else if (roll < 0.004) sim.sendHome();
        else if (roll < 0.005) sim.freeze = 8;
        sim.step();
        if (ended) expect(sim.status, `L${n} state changed after end`).toBe(ended);
        if (sim.status !== 'playing') ended = sim.status;
      }
      const snap = sim.snapshot();
      expect(snap.collected + snap.lost + snap.onBoard).toBeLessThanOrEqual(snap.total);
      expect(sim.phys.balls.every((b) => Number.isFinite(b.translation().x + b.translation().y + b.translation().z))).toBe(true);
      sim.dispose();
    }
  }, 120000);
});
