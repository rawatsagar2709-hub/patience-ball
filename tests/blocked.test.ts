import { describe, expect, it } from 'vitest';
import { generateLevel } from '@/lib/levels/levelGenerator';
import { loadRapier } from '@/lib/physics/physicsWorld';
import { Simulation } from '@/lib/physics/simulation';

describe('blocked event', () => {
  it('fires when a bigger ball sits on a smaller size green hole', async () => {
    const R = await loadRapier();
    const level = generateLevel(35, 11);
    expect(level.classRadii.length).toBeGreaterThan(1);
    const sim = new Simulation(R, level);
    const events: string[] = [];
    sim.onEvent = (e) => events.push(e);
    const big = level.balls.findIndex((b) => b.cls === level.classRadii.length - 1);
    const t = level.trays.find((tr) => tr.holes.some((h) => h.kind === 'goal' && (h.cls ?? 0) < level.balls[big].cls))!;
    const h = t.holes.find((q) => q.kind === 'goal' && (q.cls ?? 0) < level.balls[big].cls)!;
    console.log('ball r', level.balls[big].radius, 'hole r', h.r, 'cls', h.cls);
    for (let i = 0; i < 420; i++) {
      if (i === 0) { sim.phys.balls[big].setTranslation({ x: h.x, y: t.cy + 0.9, z: h.z }, true); sim.phys.balls[big].setLinvel({ x: 0, y: 0, z: 0 }, true); }
      sim.step();
      if (events.includes('blocked')) break;
    }
    const bp = sim.phys.balls[big].translation(); console.log('final', bp.x - h.x, bp.y - t.cy, bp.z - h.z);
    expect(events).toContain('blocked');
    console.log(events.filter((e) => e !== 'bump').join(','));
    sim.dispose();
  });
});
