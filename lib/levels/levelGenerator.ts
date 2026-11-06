import type { Hole, Level, Obstacle, Side, Surface, Tray } from '../types';
import { has } from '../intro';
import { getDifficulty } from './difficultyManager';
import { PLATE_T, WALL_T, footprint, obstacleExtent, rectsOverlap } from './geometry';
import { Rng, levelSeed } from './seededRandom';
import { validateLevel } from './levelValidator';

export const THEME_COUNT = 6;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const round = (v: number, n = 100) => Math.round(v * n) / n;
const SIDES: Side[] = ['+x', '-x', '+z', '-z'];
const opposite = (s: Side) => ((s[0] === '+' ? '-' : '+') + s[1]) as Side;
const MAX_TILT = (22 * Math.PI) / 180;

/** Build one level. Returns null when a random layout cannot be completed (the caller retries). */
function build(levelNumber: number, seed: number): Level | null {
  const rng = new Rng(seed);
  const diff = getDifficulty(levelNumber);

  // Ball size classes: each is ~1.6x the one below, so a hole sized for one class blocks the next.
  const kBase = diff.classesMax <= 1 ? 1 : diff.classesMax <= 2 ? 2 : rng.int(2, diff.classesMax);
  const r0 = kBase === 2 ? rng.range(0.17, 0.24) : rng.range(0.15, 0.18);
  const classRadii = [round(r0)];
  for (let j = 1; j < kBase; j++) classRadii.push(round(classRadii[j - 1] * rng.range(1.65, 1.8)));
  // Boss levels add one giant ball that must reach the biggest hole.
  if (diff.tier === 'boss') classRadii.push(round(classRadii[kBase - 1] * 1.7));
  const k = classRadii.length;
  const maxR = classRadii[k - 1];
  const wallHeight = round(2.3 * maxR + 0.2);

  // Trays.
  const count = Math.max(rng.int(diff.traysMin, diff.traysMax), levelNumber > 20 && k >= 2 ? 3 : 2); // at least 3 floors once there are 2 sizes, so their green holes can sit on different floors
  const base = 7 + 8 * maxR;
  // Boards come in different shapes: squares, wide halls and long corridors (about the same floor area).
  const dims = Array.from({ length: count }, () => {
    const asp = levelNumber >= 2 ? rng.range(0.74, 1.35) : 1;
    return { w: round(base * Math.sqrt(asp) * rng.range(0.95, 1.1)), d: round((base / Math.sqrt(asp)) * rng.range(0.95, 1.1)) };
  });
  const gapY = PLATE_T + wallHeight + 1.2;
  const trays: Tray[] = [{ index: 0, cx: 0, cy: 0, cz: 0, w: dims[0].w, d: dims[0].d, holes: [], obstacles: [], surface: 'normal', open: [], exit: null }];

  for (let i = 0; i < count - 1; i++) {
    const cur = trays[i];
    const prev = i > 0 ? trays[i].exit : null;
    void prev;
    const order = [...SIDES].sort(() => rng.float() - 0.5);
    let placed = false;
    for (const side of order) {
      if (i > 0 && side === opposite(trays[i - 1].exit!.side)) continue;
      const alongX = side[1] === 'x';
      const sgn = side[0] === '+' ? 1 : -1;
      const extCur = alongX ? cur.w : cur.d;
      const extNext = alongX ? dims[i + 1].w : dims[i + 1].d;
      const latExtCur = alongX ? cur.d : cur.w;
      const ov = extCur * rng.range(0.38, 0.55);
      const along = (alongX ? cur.cx : cur.cz) + sgn * (extCur / 2 - ov + extNext / 2);
      const lat = (alongX ? cur.cz : cur.cx) + rng.range(-0.18, 0.18) * latExtCur;
      const next: Tray = {
        index: i + 1,
        cx: alongX ? along : lat,
        cz: alongX ? lat : along,
        cy: cur.cy - gapY,
        w: dims[i + 1].w,
        d: dims[i + 1].d,
        holes: [],
        obstacles: [],
        surface: surfaceFor(levelNumber, diff.tier === 'boss', rng),
        open: [],
        exit: null,
      };
      if (next.surface === 'conveyor') { const d = [[1, 0], [-1, 0], [0, 1], [0, -1]][rng.int(0, 3)]; next.flow = { dx: d[0], dz: d[1] }; }
      const fp = footprint(next, 0.5);
      if (trays.slice(0, i).some((t) => rectsOverlap(fp, footprint(t)))) continue;
      const latLo = Math.max(alongX ? footprint(cur).z0 : footprint(cur).x0, alongX ? footprint(next).z0 : footprint(next).x0);
      const latHi = Math.min(alongX ? footprint(cur).z1 : footprint(cur).x1, alongX ? footprint(next).z1 : footprint(next).x1);
      if (latHi - latLo < 4.5) continue;
      cur.exit = { side, from: round(latLo + 0.9), to: round(latHi - 0.9) };
      trays.push(next);
      placed = true;
      break;
    }
    if (!placed) return null;
  }

  // Starting pile sits on the half of the top tray away from its exit.
  const t0 = trays[0];
  const ex0 = t0.exit!;
  const m = WALL_T + 0.35;
  const spawn = { x0: t0.cx - t0.w / 2 + m, x1: t0.cx + t0.w / 2 - m, z0: t0.cz - t0.d / 2 + m, z1: t0.cz + t0.d / 2 - m };
  if (ex0.side === '+x') spawn.x1 = t0.cx - 0.4;
  else if (ex0.side === '-x') spawn.x0 = t0.cx + 0.4;
  else if (ex0.side === '+z') spawn.z1 = t0.cz - 0.4;
  else spawn.z0 = t0.cz + 0.4;

  // Fewer borders: from level 3 some sides have no wall at all, so a careless tilt can drop balls off the edge.
  if (has('open', levelNumber)) { // no open edges early on
    const pOpen = Math.min(0.5, 0.1 + 0.02 * levelNumber);
    trays.forEach((t, i) => {
      const maxOpen = i === 0 ? 1 : diff.tier === 'boss' ? 3 : 2;
      const arriving = i > 0 ? opposite(trays[i - 1].exit!.side) : null; // the side balls spill in from keeps its wall
      for (const sd of [...SIDES].sort(() => rng.float() - 0.5)) {
        if (t.open.length >= maxOpen || sd === t.exit?.side || sd === arriving || rng.float() > pOpen) continue;
        if (i === 0 && sd === opposite(t.exit!.side)) continue; // not right behind the starting block
        t.open.push(sd);
      }
    });
  }

  // Balls: smaller sizes are more common.
  const cell = 2.2 * maxR;
  const capacity = Math.floor((spawn.x1 - spawn.x0) / cell) * Math.floor((spawn.z1 - spawn.z0) / cell) * 2;
  const n = Math.min(diff.balls + rng.int(0, 4), capacity);
  const weights = classRadii.slice(0, kBase).map((_, j) => kBase - j);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const balls = Array.from({ length: n }, () => {
    let x = rng.float() * wsum;
    let cls = 0;
    while (cls < kBase - 1 && x >= weights[cls]) x -= weights[cls++];
    return { radius: classRadii[cls], cls };
  });
  if (diff.tier === 'boss') balls[0] = { radius: classRadii[kBase], cls: kBase };
  // Every size must be present, and every size has its own quota and its own spare balls.
  for (let j = 1; j < k; j++) {
    let c = balls.filter((b) => b.cls === j).length;
    for (let i = 1; c < (diff.tier === 'boss' && j === kBase ? 1 : 2) && i < balls.length; i++) if (balls[i].cls === 0) { balls[i] = { radius: classRadii[j], cls: j }; c++; }
  }
  const counts = classRadii.map((_, j) => balls.filter((b) => b.cls === j).length);
  const classAllowed = counts.map((c) => Math.round(c * diff.lossFrac));
  const classNeed = counts.map((c, j) => c - classAllowed[j]);
  const allowedLoss = classAllowed.reduce((a, b) => a + b, 0);

  // Every ball size has its green hole on its own floor: the biggest on the last tray, the smaller ones higher up
  // (from level 21), so the pile has to be sorted as it goes down. Early levels keep all goals on the last tray.
  const lastIdx = trays.length - 1;
  const spread = levelNumber > 20 && lastIdx >= 2; // green holes on different floors only after the two easy worlds
  // Smaller sizes get their own middle floors (shuffled, one each while floors last); the biggest is always on the last floor.
  const mids = Array.from({ length: Math.max(0, lastIdx - 1) }, (_, q) => q + 1).sort(() => rng.float() - 0.5);
  const goalTray = classRadii.map((_, j) => (j === k - 1 || !spread ? lastIdx : mids[j % mids.length]));
  goalTray.sort((p, q) => p - q);

  // Holes. Traps swallow balls smaller than them; goal holes are the way out.
  let id = 0;
  const spawnRect = { x0: spawn.x0, x1: spawn.x1, z0: spawn.z0, z1: spawn.z1 };
  trays.forEach((t, i) => {
    const last = i === trays.length - 1;
    // A clear lane from where balls arrive to the way out (or the main goal), so a careful player can always get through.
    const entry = i === 0
      ? { x: (spawn.x0 + spawn.x1) / 2, z: (spawn.z0 + spawn.z1) / 2 }
      : exitPoint(trays[i - 1], 1.2);
    let lane: { x: number; z: number } | null = t.exit ? exitPoint(t, -0.6) : null;
    const laneHalf = 1.3 + maxR * 1.5;
    const wanted: Array<{ kind: Hole['kind']; r: number; cls?: number }> = [];
    // Goals for the sizes that live on this floor, biggest first (the biggest anchors the clear lane on the last tray).
    for (let j = k - 1; j >= 0; j--) if (goalTray[j] === i) wanted.push({ kind: 'goal', r: round(classRadii[j] * rng.range(1.38, 1.46), 1000), cls: j });
    // The last tray is the final exam: fewer traps, so the goal is not ringed by them.
    const trapCap = last ? Math.min(diff.trapsMax, 2 + Math.floor(levelNumber / 12)) : diff.trapsMax;
    for (let q = rng.int(Math.min(diff.trapsMin, trapCap), trapCap); q > 0; q--) {
      wanted.push({ kind: 'trap', r: round(classRadii[rng.int(0, kBase - 1)] * rng.range(1.22, 1.3), 1000) });
    }
    for (const w of wanted) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const edge = WALL_T + w.r + 0.35;
        const x = round(rng.range(t.cx - t.w / 2 + edge, t.cx + t.w / 2 - edge), 1000);
        const z = round(rng.range(t.cz - t.d / 2 + edge, t.cz + t.d / 2 - edge), 1000);
        if (t.holes.some((h) => Math.hypot(h.x - x, h.z - z) < h.r + w.r + 0.5)) continue;
        if (i === 0 && x > spawnRect.x0 - w.r && x < spawnRect.x1 + w.r && z > spawnRect.z0 - w.r && z < spawnRect.z1 + w.r) continue;
        if (trays.slice(i + 1).some((lower) => {
          const f = footprint(lower, w.r + 0.3);
          return x > f.x0 && x < f.x1 && z > f.z0 && z < f.z1;
        })) continue;
        if (t.exit && nearExit(t, x, z, w.r)) continue;
        if (w.kind === 'trap' && t.holes.some((h) => h.kind === 'goal' && Math.hypot(h.x - x, h.z - z) < h.r + w.r + 1.6)) continue;
        if (lane && segDist(x, z, entry.x, entry.z, lane.x, lane.z) < laneHalf + w.r) continue;
        if (last && !lane && w.kind === 'goal' && Math.hypot(x - entry.x, z - entry.z) < 3.5) continue;
        t.holes.push({ id: id++, kind: w.kind, x, z, r: w.r, ...(w.cls !== undefined && { cls: w.cls }) });
        if (last && !lane && w.kind === 'goal') lane = { x, z }; // the first (largest) goal anchors the lane
        break;
      }
    }

    // Decoys: red holes appear at random spots within a short radius of the green holes.
    if (levelNumber >= 12 && !diff.relaxed && t.holes.some((h) => h.kind === 'goal')) {
      const goals = t.holes.filter((h) => h.kind === 'goal').sort(() => rng.float() - 0.5);
      let near = Math.min(goals.length + 1, 1 + Math.floor((levelNumber - 12) / 8), 3);
      for (let gi = 0; near > 0 && gi < goals.length * 2; gi++) {
        const gh = goals[gi % goals.length];
        for (let attempt = 0; attempt < 30; attempt++) {
          const r = round(classRadii[rng.int(0, kBase - 1)] * rng.range(1.22, 1.3), 1000);
          const ang = rng.range(0, Math.PI * 2);
          const dist = gh.r + r + rng.range(0.45, 2.2);
          const x = round(gh.x + Math.cos(ang) * dist, 1000);
          const z = round(gh.z + Math.sin(ang) * dist, 1000);
          const edge = WALL_T + r + 0.35;
          if (x < t.cx - t.w / 2 + edge || x > t.cx + t.w / 2 - edge || z < t.cz - t.d / 2 + edge || z > t.cz + t.d / 2 - edge) continue;
          if (t.holes.some((h) => Math.hypot(h.x - x, h.z - z) < h.r + r + 0.45)) continue;
          if (t.exit && lane && segDist(x, z, entry.x, entry.z, lane.x, lane.z) < laneHalf + r) continue; // keep the way through clear
          if (trays.slice(i + 1).some((lower) => { const f = footprint(lower, r + 0.3); return x > f.x0 && x < f.x1 && z > f.z0 && z < f.z1; })) continue;
          t.holes.push({ id: id++, kind: 'trap', x, z, r });
          near--;
          break;
        }
      }
    }

    // Obstacles: pegs from the start, then walls, boost pads and sweepers as levels get harder.
    const boss = diff.tier === 'boss';
    const kinds: Array<Obstacle['kind'] | 'barrier' | 'doorwall' | 'slotwall' | 'pinball'> = ['peg'];
    if (boss) kinds.push('bar'); // lone bars are rare: too many borders make it easy
    const ok = (key: string) => has(key, levelNumber);
    if (ok('patch-ice') || ok('patch-rough') || ok('patch-bouncy')) kinds.push('patch');
    if (ok('slotwall')) kinds.push('slotwall');
    if (ok('pinball')) kinds.push('pinball', 'pinball'); // twice as likely: it is a set piece and often cannot fit
    for (const k2 of ['bumper', 'barrier', 'magnet', 'filter', 'doorwall', 'spinner', 'mud', 'gate', 'block', 'sweeper', 'portal', 'boost', 'flap'] as const) if (ok(k2)) kinds.push(k2);
    const pad = maxR * 2.7;
    const taken = t.holes.map((h) => ({ x: h.x, z: h.z, ex: h.r, ez: h.r }));
    const want = diff.obstacles > 0 ? rng.int(Math.floor(diff.obstacles / 2), diff.obstacles) : 0;
    // Try a spot for an obstacle; on success it is placed (x, z set) but not yet recorded.
    const fits = (o: Obstacle, near?: { x: number; z: number; r: number }, anyLane = false) => {
      const [ex, ez] = obstacleExtent(o);
      const gap = o.kind === 'patch' ? 0.6 : pad; // flat patches can sit closer to things than tall obstacles
      if (o.kind === 'block') {
        // Blocks fill a corner of the tray.
        o.x = round(t.cx + (rng.float() < 0.5 ? -1 : 1) * (t.w / 2 - WALL_T - o.hx), 1000);
        o.z = round(t.cz + (rng.float() < 0.5 ? -1 : 1) * (t.d / 2 - WALL_T - o.hz), 1000);
      } else {
        const lx = [t.cx - t.w / 2 + WALL_T + ex + gap / 2, t.cx + t.w / 2 - WALL_T - ex - gap / 2];
        const lz = [t.cz - t.d / 2 + WALL_T + ez + gap / 2, t.cz + t.d / 2 - WALL_T - ez - gap / 2];
        if (lx[0] >= lx[1] || lz[0] >= lz[1]) return false;
        if (near) {
          const a = rng.range(0, Math.PI * 2), d = near.r + ex + rng.range(0.9, 2.2);
          o.x = round(Math.max(lx[0], Math.min(lx[1], near.x + Math.cos(a) * d)), 1000);
          o.z = round(Math.max(lz[0], Math.min(lz[1], near.z + Math.sin(a) * d)), 1000);
        } else {
          o.x = round(rng.range(lx[0], lx[1]), 1000);
          o.z = round(rng.range(lz[0], lz[1]), 1000);
        }
      }
      // Sweepers cross the lane on purpose and mud only slows, so those keep the lane clear by their resting size (mud not at all).
      const br = o.kind === 'sweeper' ? Math.hypot(o.hx, o.hz) : o.kind === 'block' ? Math.min(ex, ez) : Math.hypot(ex, ez);
      if (taken.some((b) => Math.abs(b.x - o.x) < b.ex + ex + gap && Math.abs(b.z - o.z) < b.ez + ez + gap)) return false;
      if (i === 0 && o.x + ex > spawnRect.x0 - 0.6 && o.x - ex < spawnRect.x1 + 0.6 && o.z + ez > spawnRect.z0 - 0.6 && o.z - ez < spawnRect.z1 + 0.6) return false;
      if (i > 0 && Math.hypot(o.x - entry.x, o.z - entry.z) < 3 + br) return false;
      if (t.exit && nearExit(t, o.x, o.z, br)) return false;
      if (o.kind !== 'mud' && o.kind !== 'patch' && o.kind !== 'magnet' && !anyLane && lane && segDist(o.x, o.z, entry.x, entry.z, lane.x, lane.z) < laneHalf + br) return false;
      return true;
    };
    const commit = (o: Obstacle) => {
      const [ex, ez] = obstacleExtent(o);
      t.obstacles.push(o);
      taken.push({ x: o.x, z: o.z, ex, ez });
    };
    // A gap wall: a full-width wall across the way through, with a narrow gap that only the smaller balls fit
    // and a wide gap (usually on the far side) that every size fits. Big balls have to be steered around.
    const tryBarrier = () => {
      if (!lane) return false;
      const dx = lane.x - entry.x, dz = lane.z - entry.z;
      const alongX = Math.abs(dx) >= Math.abs(dz);
      if (Math.hypot(dx, dz) < 5) return false;
      const f = rng.range(0.35, 0.8);
      const wpos = alongX ? entry.x + dx * f : entry.z + dz * f;
      const lo = (alongX ? t.cz - t.d / 2 : t.cx - t.w / 2) + WALL_T;
      const hi = (alongX ? t.cz + t.d / 2 : t.cx + t.w / 2) - WALL_T;
      const flowLo = (alongX ? t.cx - t.w / 2 : t.cz - t.d / 2) + 2.5;
      const flowHi = (alongX ? t.cx + t.w / 2 : t.cz + t.d / 2) - 2.5;
      if (wpos < flowLo || wpos > flowHi) return false;
      if (i === 0 && (alongX ? wpos > spawnRect.x0 - 0.8 && wpos < spawnRect.x1 + 0.8 : wpos > spawnRect.z0 - 0.8 && wpos < spawnRect.z1 + 0.8)) return false;
      if (t.holes.some((h) => Math.abs((alongX ? h.x : h.z) - wpos) < h.r + 0.5)) return false;
      if (taken.some((b) => Math.abs(wpos - (alongX ? b.x : b.z)) < (alongX ? b.ex : b.ez) + 0.6)) return false;
      if (t.exit && nearExit(t, alongX ? wpos : (lo + hi) / 2, alongX ? (lo + hi) / 2 : wpos, 1)) return false;
      const gw = Math.min(Math.max(2 * maxR * 2.3, 1.6), (hi - lo) * 0.33);
      const gn = 2 * classRadii[k - 2] * 1.45; // lets every size but the biggest through
      const laneLat = alongX ? entry.z + dz * f : entry.x + dx * f; // where the straight path crosses the wall
      const mid = (lo + hi) / 2;
      const room = (hi - lo) / 2 - gw / 2 - 0.4;
      const cw = mid + (laneLat > mid ? -1 : 1) * rng.range(room * 0.4, room); // wide gap on the side away from the lane
      const cn = Math.max(lo + gn / 2 + 0.4, Math.min(hi - gn / 2 - 0.4, laneLat));
      if (Math.abs(cn - cw) < (gw + gn) / 2 + 0.6) return false;
      const gaps = [{ a: cw - gw / 2, b: cw + gw / 2 }, { a: cn - gn / 2, b: cn + gn / 2 }].sort((p, q) => p.a - q.a);
      const edges = [lo, gaps[0].a, gaps[0].b, gaps[1].a, gaps[1].b, hi];
      const segs: Obstacle[] = [];
      for (let s = 0; s < 6; s += 2) {
        const len = edges[s + 1] - edges[s];
        if (len < 0.3) continue;
        const c = (edges[s] + edges[s + 1]) / 2;
        segs.push({ id: id + segs.length, kind: 'bar', x: round(alongX ? wpos : c, 1000), z: round(alongX ? c : wpos, 1000), hx: alongX ? 0.14 : round(len / 2, 1000), hz: alongX ? round(len / 2, 1000) : 0.14 });
      }
      segs.forEach((o) => commit(o));
      id += segs.length;
      return true;
    };
    // A timed door: a full-width wall across the way through that is only open for a fixed time in every cycle.
    const tryDoor = (slots = 1) => {
      if (!lane) return false;
      const dx = lane.x - entry.x, dz = lane.z - entry.z;
      const alongX = Math.abs(dx) >= Math.abs(dz);
      if (Math.hypot(dx, dz) < 5) return false;
      const f = rng.range(0.4, 0.75);
      const wpos = alongX ? entry.x + dx * f : entry.z + dz * f;
      const lo = (alongX ? t.cz - t.d / 2 : t.cx - t.w / 2) + WALL_T;
      const hi = (alongX ? t.cz + t.d / 2 : t.cx + t.w / 2) - WALL_T;
      const flowLo = (alongX ? t.cx - t.w / 2 : t.cz - t.d / 2) + 2.5;
      const flowHi = (alongX ? t.cx + t.w / 2 : t.cz + t.d / 2) - 2.5;
      if (wpos < flowLo || wpos > flowHi) return false;
      if (i === 0 && (alongX ? wpos > spawnRect.x0 - 0.8 && wpos < spawnRect.x1 + 0.8 : wpos > spawnRect.z0 - 0.8 && wpos < spawnRect.z1 + 0.8)) return false;
      if (t.holes.some((h) => Math.abs((alongX ? h.x : h.z) - wpos) < h.r + 0.7)) return false;
      if (taken.some((b) => Math.abs(wpos - (alongX ? b.x : b.z)) < (alongX ? b.ex : b.ez) + 0.8)) return false;
      if (t.exit && nearExit(t, alongX ? wpos : (lo + hi) / 2, alongX ? (lo + hi) / 2 : wpos, 1)) return false;
      const c = (lo + hi) / 2, half = (hi - lo) / 2 - 0.02; // a hair inside the walls
      if (slots > 1) {
        // Slot wall: the wall is split into lanes whose doors open one after another, so a different lane is open every few seconds.
        const open = round(rng.range(2.2, 2.8)), closed = round(open * (slots - 1)), base = round(rng.range(0, 6)), seg = (hi - lo) / slots;
        for (let k = 0; k < slots; k++) {
          const sc = lo + seg * (k + 0.5), sh = seg / 2 - 0.02;
          commit({ id, kind: 'door', slot: true, x: round(alongX ? wpos : sc, 1000), z: round(alongX ? sc : wpos, 1000), hx: alongX ? 0.2 : round(sh, 1000), hz: alongX ? round(sh, 1000) : 0.2, open, closed, offset: round(base + k * open, 100) });
          id++;
        }
        return true;
      }
      const o: Obstacle = { id, kind: 'door', x: round(alongX ? wpos : c, 1000), z: round(alongX ? c : wpos, 1000), hx: alongX ? 0.2 : round(half, 1000), hz: alongX ? round(half, 1000) : 0.2, open: round(rng.range(3.2, 4.4)), closed: round(rng.range(2.6, 4)), offset: round(rng.range(0, 6)) };
      commit(o);
      id++;
      return true;
    };
    // Guards: a few obstacles close around each green hole, so the last stretch is never a free roll.
    if (levelNumber >= 8) {
      const guardKinds = kinds.filter((x) => x !== 'barrier' && x !== 'doorwall' && x !== 'slotwall' && x !== 'pinball' && x !== 'portal' && x !== 'block' && x !== 'bar');
      for (const g of t.holes.filter((h) => h.kind === 'goal')) {
        const n = rng.int(1, levelNumber >= 31 ? 3 : levelNumber >= 21 ? 2 : 1);
        for (let q = 0, placed = 0; q < 40 && placed < n; q++) {
          const o = makeObstacle(guardKinds[rng.int(0, guardKinds.length - 1)] as Obstacle['kind'], rng, id, levelNumber, k);
          if (fits(o, g) && Math.hypot(o.x - g.x, o.z - g.z) < g.r + 4) { commit(o); id++; placed++; }
        }
      }
    }
    for (let q = 0; q < want; q++) {
      const kind = kinds[rng.int(0, kinds.length - 1)];
      if (kind === 'slotwall') {
        for (let attempt = 0; attempt < 20 && !tryDoor(3); attempt++);
        continue;
      }
      if (kind === 'pinball') {
        // Set piece: a diamond of five bumpers that ping balls around.
        for (let attempt = 0; attempt < 30; attempt++) {
          const cluster: Obstacle[] = [];
          const sp = 1.15;
          const area = makeObstacle('bumper', rng, id, levelNumber, k) as Extract<Obstacle, { kind: 'bumper' }>;
          area.r = sp + 0.4; // reserve the whole diamond's footprint
          if (!fits(area, undefined, true)) continue; // bumpers only deflect, so the diamond may sit on the main lane
          const cx0 = area.x, cz0 = area.z;
          [[0, 0], [sp, sp], [-sp, sp], [sp, -sp], [-sp, -sp]].forEach(([ox, oz], q) => cluster.push({ id: id + q, kind: 'bumper', x: round(cx0 + ox, 1000), z: round(cz0 + oz, 1000), r: 0.36 }));
          cluster.forEach((c2) => commit(c2));
          id += cluster.length;
          break;
        }
        continue;
      }
      if (kind === 'doorwall') {
        for (let attempt = 0; attempt < 20 && !tryDoor(); attempt++);
        continue;
      }
      if (kind === 'barrier') {
        for (let attempt = 0; attempt < 20 && !tryBarrier(); attempt++);
        continue;
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        if (kind === 'portal') {
          // Portals come as a linked pair on the same tray.
          const a = makeObstacle(kind, rng, id, levelNumber, k) as Extract<Obstacle, { kind: 'portal' }>;
          const b = makeObstacle(kind, rng, id + 1, levelNumber, k) as Extract<Obstacle, { kind: 'portal' }>;
          if (!fits(a)) continue;
          commit(a);
          if (!fits(b)) { t.obstacles.pop(); taken.pop(); continue; }
          if (Math.hypot(a.x - b.x, a.z - b.z) < 4) { t.obstacles.pop(); taken.pop(); continue; }
          b.tone = 1;
          a.tx = b.x; a.tz = b.z; b.tx = a.x; b.tz = a.z;
          commit(b);
          id += 2;
          break;
        }
        const o = makeObstacle(kind, rng, id, levelNumber, k);
        if (fits(o)) { commit(o); id++; break; }
      }
    }
  });
  if (!classRadii.every((_, j) => trays[goalTray[j]].holes.some((h) => h.kind === 'goal' && h.cls === j))) return null;

  const minY = trays[trays.length - 1].cy - PLATE_T / 2;
  const bounds = {
    min: [Math.min(...trays.map((t) => t.cx - t.w / 2)), minY - 0.3, Math.min(...trays.map((t) => t.cz - t.d / 2))] as [number, number, number],
    max: [Math.max(...trays.map((t) => t.cx + t.w / 2)), PLATE_T / 2 + wallHeight, Math.max(...trays.map((t) => t.cz + t.d / 2))] as [number, number, number],
  };
  return {
    levelNumber,
    seed,
    theme: (Math.ceil(levelNumber / 10) - 1) % THEME_COUNT,
    tier: diff.tier,
    classRadii,
    balls,
    trays,
    wallHeight,
    required: n - allowedLoss,
    allowedLoss,
    classNeed,
    classAllowed,
    maxTilt: MAX_TILT,
    spawn,
    bounds,
    abyssY: bounds.min[1] - 10,
    fallback: false,
  };
}

/** Which floor material a tray gets; other materials unlock as levels go on. */
function surfaceFor(levelNumber: number, boss: boolean, rng: Rng): Surface {
  const pool: Surface[] = [];
  for (const k of ['ice', 'sticky', 'bouncy', 'conveyor'] as const) if (has(k, levelNumber)) pool.push(k);
  if (!pool.length || rng.float() > (boss ? 0.65 : 0.4)) return 'normal';
  return pool[rng.int(0, pool.length - 1)];
}

/** A fresh obstacle of the given kind; the caller picks its position. */
function makeObstacle(kind: Obstacle['kind'], rng: Rng, id: number, levelNumber: number, classCount: number): Obstacle {
  const flip = rng.float() < 0.5;
  switch (kind) {
    case 'peg': return { id, kind, x: 0, z: 0, r: round(rng.range(0.3, 0.55)) };
    case 'bar': { const len = round(rng.range(1.0, 2.0)); return { id, kind, x: 0, z: 0, hx: flip ? len : 0.14, hz: flip ? 0.14 : len }; }
    case 'sweeper': {
      const axis = flip ? 'x' : 'z';
      const len = round(rng.range(1.0, 1.7));
      return { id, kind, x: 0, z: 0, hx: axis === 'x' ? 0.15 : len, hz: axis === 'x' ? len : 0.15, axis, amp: round(rng.range(1.1, 1.9)), speed: round(rng.range(0.8, 1.6)), phase: round(rng.range(0, 6.28)) };
    }
    case 'patch': {
      // Floor patches differ in size, shape and feel; rougher and bouncier ones unlock later.
      const mats = (['ice', 'rough', 'bouncy'] as const).filter((m) => has(`patch-${m}`, levelNumber));
      const mat = mats[rng.int(0, mats.length - 1)];
      if (rng.float() < 0.5) { const r = round(rng.range(0.8, 2.0)); return { id, kind, shape: 'round', mat, x: 0, z: 0, hx: r, hz: r }; }
      return { id, kind, shape: 'rect', mat, x: 0, z: 0, hx: round(rng.range(0.8, 2.3)), hz: round(rng.range(0.6, 1.7)) };
    }
    case 'filter': {
      const len = round(rng.range(1.2, 2.2));
      return { id, kind, x: 0, z: 0, hx: flip ? len : 0.16, hz: flip ? 0.16 : len, pass: rng.float() < 0.5 ? 'small' : 'big', cut: rng.int(1, Math.max(1, classCount - 1)) };
    }
    case 'block': return { id, kind, x: 0, z: 0, hx: round(rng.range(1.0, 2.2)), hz: round(rng.range(1.0, 2.2)) };
    case 'bumper': return { id, kind, x: 0, z: 0, r: round(rng.range(0.35, 0.5)) };
    case 'mud': return { id, kind, x: 0, z: 0, hx: round(rng.range(1.0, 1.8)), hz: round(rng.range(0.8, 1.4)) };
    case 'spinner': return { id, kind, x: 0, z: 0, len: round(rng.range(0.9, 1.5)), speed: round((flip ? 1 : -1) * rng.range(1.2, 2.2)), phase: round(rng.range(0, 6.28)) };
    case 'flap': {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const [dx, dz] = dirs[rng.int(0, 3)];
      const len = round(rng.range(1.4, 2.4));
      return { id, kind: 'flap', x: 0, z: 0, hx: dx ? 0.12 : len, hz: dx ? len : 0.12, dx, dz };
    }
    case 'magnet': return { id, kind, x: 0, z: 0, r: round(rng.range(1.9, 2.6)), push: rng.float() < 0.5 ? 1 : -1 };
    case 'gate': { const len = round(rng.range(1.2, 2.0)); return { id, kind, x: 0, z: 0, hx: flip ? len : 0.18, hz: flip ? 0.18 : len, speed: round(rng.range(0.8, 1.4)), phase: round(rng.range(0, 6.28)) }; }
    case 'portal': return { id, kind, x: 0, z: 0, r: 0.55, tx: 0, tz: 0, tone: 0 };
    default: {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const [dx, dz] = dirs[rng.int(0, 3)];
      return { id, kind: 'boost', x: 0, z: 0, hx: round(rng.range(0.8, 1.2)), hz: round(rng.range(0.8, 1.2)), dx, dz };
    }
  }
}

/** Distance from point p to segment a-b. */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Point just inside (inward=true) or just outside a tray's exit gap, on its centre line. */
function exitPoint(t: Tray, offset: number) {
  const ex = t.exit!;
  const sgn = ex.side[0] === '+' ? 1 : -1;
  const mid = (ex.from + ex.to) / 2;
  return ex.side[1] === 'x' ? { x: t.cx + sgn * (t.w / 2 + offset), z: mid } : { x: mid, z: t.cz + sgn * (t.d / 2 + offset) };
}

/** True when (x,z) sits in front of the exit gap, where a hole would block the way out. */
function nearExit(t: Tray, x: number, z: number, r: number) {
  const ex = t.exit!;
  const alongX = ex.side[1] === 'x';
  const sgn = ex.side[0] === '+' ? 1 : -1;
  const dist = alongX ? sgn * ((t.cx + (sgn * t.w) / 2) - x) : sgn * ((t.cz + (sgn * t.d) / 2) - z);
  const lat = alongX ? z : x;
  return dist < 2 + r && lat > ex.from - 0.6 - r && lat < ex.to + 0.6 + r;
}

/** Hand-made two-tray level, always valid. Used only if every generated attempt fails validation. */
function fallbackLevel(levelNumber: number, seed: number): Level {
  const t0: Tray = { index: 0, cx: 0, cy: 0, cz: 0, w: 9, d: 9, holes: [], obstacles: [], surface: 'normal', open: [], exit: { side: '+x', from: -2.5, to: 2.5 } };
  const t1: Tray = {
    index: 1, cx: 5, cy: -2.6, cz: 0, w: 9, d: 9, exit: null, obstacles: [], surface: 'normal', open: [],
    holes: [{ id: 0, kind: 'goal', x: 7, z: 0, r: 0.42, cls: 0 }, { id: 1, kind: 'trap', x: 6, z: 3, r: 0.37 }],
  };
  const balls = Array.from({ length: 10 }, () => ({ radius: 0.3, cls: 0 }));
  return {
    levelNumber, seed, theme: 0, tier: 'normal', classRadii: [0.3], balls, trays: [t0, t1], wallHeight: 0.9, required: 8, allowedLoss: 2, classNeed: [8], classAllowed: [2], maxTilt: MAX_TILT,
    spawn: { x0: -4.2, x1: -0.4, z0: -4.2, z1: 4.2 },
    bounds: { min: [-4.5, -2.9, -4.5], max: [9.5, 0.9, 4.5] },
    abyssY: -13, fallback: true,
  };
}

/** Deterministic: the same (levelNumber, seed) always yields the same level. */
export function generateLevel(levelNumber: number, seed?: number): Level {
  const L = Math.max(1, Math.floor(levelNumber));
  const base = seed ?? levelSeed(L);
  for (let attempt = 0; attempt < 120; attempt++) {
    const level = build(L, attempt === 0 ? base : levelSeed(base, attempt));
    if (level && validateLevel(level).length === 0) {
      level.seed = base;
      return level;
    }
  }
  return fallbackLevel(L, base);
}

/** A fresh random seed for "random level" play. */
export const randomSeed = () => (Math.random() * 0x7fffffff) | 0;
void lerp;
