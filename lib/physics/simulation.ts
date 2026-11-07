import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { GameSnapshot, Level } from '../types';
import { PLATE_T, spawnPositions } from '../levels/geometry';
import { FIXED_DT, GRAVITY, PhysicsWorld } from './physicsWorld';

export type SimEvent = 'collected' | 'lost' | 'won' | 'failed' | 'bump' | 'portal' | 'blocked';
export type BallStatus = 'active' | 'collected' | 'lost' | 'reserve';

const FALL_BAND = 0.6; // how far below a plate a ball must be (and no further) to count as having dropped through
const TILT_RESPONSE = 7; // 1/s, how quickly the board follows the input

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

/** Headless game rules on top of physics. The renderer and the tests both drive this. */
export class Simulation {
  readonly level: Level;
  readonly phys: PhysicsWorld;
  readonly status_: BallStatus[];
  /** Board rotation the renderer applies to the whole assembly. */
  readonly quat = new THREE.Quaternion();
  status: GameSnapshot['status'] = 'playing';
  collected = 0;
  lost = 0;
  readonly classCollected: number[];
  readonly classLost: number[];
  elapsed = 0;
  /** Clock that drives the moving obstacles; it stops while they are frozen. */
  moverClock = 0;
  freeze = 0;
  private spawn: Array<{ x: number; y: number; z: number }>;
  /** Why and where each ball was lost; handy for debugging level design. */
  /** Seconds each ball has sat on top of a green hole too small for it (the "blocked" event). */
  private blockT: number[] = [];
  private blockedAt: number[] = [];
  readonly lossLog: Array<{ ball: number; tray: number; how: 'trap' | 'void'; t: number; at?: string }> = [];
  onEvent: (e: SimEvent) => void = () => {};
  private tx = 0;
  private tz = 0;
  private sx = 0;
  private sz = 0;
  private hidden: boolean[];
  /** Last time each ball was kicked by a bumper or sent through a portal (so it is not done again at once). */
  private kick: number[];
  private tele: number[];
  /** True while a ball that just came out of a portal is still sitting on a portal (it must roll off before it can teleport again). */
  private inPortal: boolean[];
  private portals: Array<{ x: number; z: number; r: number }>;

  constructor(R: typeof RAPIER, level: Level) {
    this.level = level;
    this.phys = new PhysicsWorld(R, level);
    this.spawn = spawnPositions(level);
    this.spawn.forEach((p, i) => this.phys.addBall(p.x, p.y, p.z, level.balls[i].radius, level.balls[i].cls));
    const firstReserve = level.balls.length - (level.reserve ?? 0);
    this.status_ = level.balls.map((_, i) => (i >= firstReserve ? 'reserve' : 'active'));
    this.hidden = level.balls.map((_, i) => i >= firstReserve);
    this.hidden.forEach((h, i) => { if (h) this.phys.balls[i].setEnabled(false); });
    this.kick = level.balls.map(() => -9);
    this.tele = level.balls.map(() => -9);
    this.inPortal = level.balls.map(() => false);
    this.portals = level.trays.flatMap((t) => t.obstacles.flatMap((o) => (o.kind === 'portal' ? [{ x: o.x, z: o.z, r: o.r }] : [])));
    this.classCollected = level.classNeed.map(() => 0);
    this.classLost = level.classNeed.map(() => 0);
    this.applyTilt();
  }

  /** Input in [-1,1]: +x tips the right side down, +z tips the near (camera) side down. */
  setInput(x: number, z: number) {
    const m = Math.hypot(x, z);
    const k = m > 1 ? 1 / m : 1;
    this.tx = x * k;
    this.tz = z * k;
  }

  /** Ability: bring in one spare ball from the start area. */
  addReserve(): boolean {
    const i = this.status_.indexOf('reserve');
    if (i < 0 || this.status !== 'playing') return false;
    const p = this.spawn[i], b = this.phys.balls[i];
    this.status_[i] = 'active';
    this.hidden[i] = false;
    b.setEnabled(true);
    b.setTranslation({ x: p.x, y: p.y + 1.2, z: p.z }, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    return true;
  }

  /** Ability: one ball that is still needed goes straight into its hole. */
  sendHome(): boolean {
    if (this.status !== 'playing') return false;
    const { classNeed } = this.level;
    let best = -1, bestLeft = 0;
    classNeed.forEach((n, j) => {
      const left = n - this.classCollected[j];
      if (left > bestLeft && this.status_.some((s, i) => s === 'active' && !this.hidden[i] && this.level.balls[i].cls === j)) { best = j; bestLeft = left; }
    });
    if (best < 0) return false;
    const i = this.status_.findIndex((s, k) => s === 'active' && !this.hidden[k] && this.level.balls[k].cls === best);
    this.status_[i] = 'collected';
    this.collected++; this.classCollected[best]++;
    this.phys.balls[i].setEnabled(false);
    this.hidden[i] = true;
    this.onEvent('collected');
    return true;
  }

  isHidden(i: number) {
    return this.hidden[i];
  }

  private applyTilt() {
    const { maxTilt } = this.level;
    const qz = new THREE.Quaternion().setFromAxisAngle(AXIS_Z, -maxTilt * this.sx);
    const qx = new THREE.Quaternion().setFromAxisAngle(AXIS_X, maxTilt * this.sz);
    this.quat.copy(qx).multiply(qz);
    // The board is rotated by quat, so in the board's own frame gravity is rotated by the inverse.
    const g = new THREE.Vector3(0, -GRAVITY, 0).applyQuaternion(this.quat.clone().invert());
    this.phys.setGravity(g.x, g.y, g.z);
  }

  step() {
    const k = 1 - Math.exp(-TILT_RESPONSE * FIXED_DT);
    this.sx += (this.tx - this.sx) * k;
    this.sz += (this.tz - this.sz) * k;
    this.applyTilt();
    this.applyFields();
    this.phys.step(this.moverClock);
    if (this.freeze > 0) this.freeze -= FIXED_DT; else this.moverClock += FIXED_DT;
    if (this.status !== 'playing') return;
    this.elapsed += FIXED_DT;
    this.classify();
    this.checkEnd();
  }

  /** Pads, mud, bumpers and portals act on any ball that is on the tray floor. */
  private applyFields() {
    const PUSH = 24;
    if (this.portals.length) {
      this.inPortal.forEach((on, i) => {
        if (!on) return;
        const p = this.phys.balls[i].translation();
        if (this.portals.every((q) => Math.hypot(p.x - q.x, p.z - q.z) > q.r * 1.3)) this.inPortal[i] = false;
      });
    }
    for (const t of this.level.trays) {
      const top = t.cy + PLATE_T / 2;
      if (t.surface === 'sticky') {
        // A sticky floor drags on every ball rolling over it.
        this.status_.forEach((st, i) => {
          if (st !== 'active' || this.hidden[i]) return;
          const b = this.phys.balls[i];
          const p = b.translation();
          if (Math.abs(p.y - (top + this.level.balls[i].radius)) > 0.45 || Math.abs(p.x - t.cx) > t.w / 2 || Math.abs(p.z - t.cz) > t.d / 2) return;
          const v = b.linvel();
          const k = b.mass() * 3 * FIXED_DT;
          b.applyImpulse({ x: -v.x * k, y: 0, z: -v.z * k }, true);
        });
      }
      if (t.flow) {
        // A conveyor floor carries every ball resting on it.
        const f = t.flow;
        this.status_.forEach((st, i) => {
          if (st !== 'active' || this.hidden[i]) return;
          const b = this.phys.balls[i];
          const p = b.translation();
          if (Math.abs(p.y - (top + this.level.balls[i].radius)) > 0.45 || Math.abs(p.x - t.cx) > t.w / 2 || Math.abs(p.z - t.cz) > t.d / 2) return;
          const m = b.mass() * 6 * FIXED_DT;
          b.applyImpulse({ x: f.dx * m, y: 0, z: f.dz * m }, true);
        });
      }
      for (const o of t.obstacles) {
        if (o.kind !== 'boost' && o.kind !== 'mud' && o.kind !== 'bumper' && o.kind !== 'portal' && o.kind !== 'patch' && o.kind !== 'magnet' && o.kind !== 'flap') continue;
        this.status_.forEach((st, i) => {
          if (st !== 'active' || this.hidden[i]) return;
          const b = this.phys.balls[i];
          const p = b.translation();
          const r = this.level.balls[i].radius;
          if (Math.abs(p.y - (top + r)) > 0.45) return;
          if (o.kind === 'bumper') {
            const dx = p.x - o.x, dz = p.z - o.z;
            const d = Math.hypot(dx, dz) || 1;
            if (d > o.r + r + 0.08 || this.elapsed - this.kick[i] < 0.12) return;
            const v = b.linvel();
            const vn = (v.x * dx + v.z * dz) / d;
            const m = b.mass() * Math.max(0, 6 - vn);
            b.applyImpulse({ x: (dx / d) * m, y: 0, z: (dz / d) * m }, true);
            this.kick[i] = this.elapsed;
            this.onEvent('bump');
            return;
          }
          if (o.kind === 'flap') {
            // One-way: a ball at the flap that is rolling against its direction is turned back.
            const ax = p.x - o.x, az = p.z - o.z;
            const along = ax * o.dx + az * o.dz;
            const lat = Math.abs(-ax * o.dz + az * o.dx);
            const half = o.dx ? o.hz : o.hx;
            if (lat > half + r || Math.abs(along) > r + 0.2 || along < -0.02) return;
            const v = b.linvel();
            const vd = v.x * o.dx + v.z * o.dz;
            if (vd < -0.05) { const m = b.mass() * -vd * 1.6; b.applyImpulse({ x: o.dx * m, y: 0, z: o.dz * m }, true); }
            return;
          }
          if (o.kind === 'magnet') {
            const dx = o.x - p.x, dz = o.z - p.z;
            const d = Math.hypot(dx, dz);
            if (d > o.r || d < 0.05) return;
            const m = b.mass() * (o.push > 0 ? 9 : 13) * (1 - d / o.r) * FIXED_DT * o.push;
            b.applyImpulse({ x: (dx / d) * m, y: 0, z: (dz / d) * m }, true);
            return;
          }
          if (o.kind === 'portal') {
            if (Math.hypot(p.x - o.x, p.z - o.z) > o.r * 0.8 || this.inPortal[i]) return;
            b.setTranslation({ x: o.tx, y: p.y, z: o.tz }, true);
            this.inPortal[i] = true;
            this.tele[i] = this.elapsed;
            this.onEvent('portal');
            return;
          }
          if (o.kind === 'patch') {
            const inside = o.shape === 'round' ? Math.hypot(p.x - o.x, p.z - o.z) < o.hx : Math.abs(p.x - o.x) < o.hx && Math.abs(p.z - o.z) < o.hz;
            if (!inside) return;
            const v = b.linvel();
            if (o.mat === 'ice') {
              // Slippery: no rolling resistance, so momentum carries (capped so it stays controllable).
              if (Math.hypot(v.x, v.z) < 9) { const k = b.mass() * 1.6 * FIXED_DT; b.applyImpulse({ x: v.x * k, y: 0, z: v.z * k }, true); }
            } else if (o.mat === 'rough') {
              const k = b.mass() * 5 * FIXED_DT;
              b.applyImpulse({ x: -v.x * k, y: 0, z: -v.z * k }, true);
            } else if (this.elapsed - this.kick[i] > 0.5) {
              // Hop: apex kept well below the walls so a ball can never be flung out of the tray.
              const apex = Math.max(0.12, this.level.wallHeight * 0.4 - r);
              b.applyImpulse({ x: 0, y: b.mass() * Math.min(4.2, Math.sqrt(2 * GRAVITY * apex)), z: 0 }, true);
              this.kick[i] = this.elapsed;
            }
            return;
          }
          if (Math.abs(p.x - o.x) > o.hx || Math.abs(p.z - o.z) > o.hz) return;
          if (o.kind === 'mud') {
            const v = b.linvel();
            const k = b.mass() * 6 * FIXED_DT;
            b.applyImpulse({ x: -v.x * k, y: 0, z: -v.z * k }, true);
          } else {
            const m = b.mass() * PUSH * FIXED_DT;
            b.applyImpulse({ x: o.dx * m, y: 0, z: o.dz * m }, true);
          }
        });
      }
    }
  }

  private classify() {
    const { level } = this;
    const lastY = level.trays[level.trays.length - 1].cy;
    this.status_.forEach((st, i) => {
      if (this.hidden[i]) return;
      const b = this.phys.balls[i];
      const p = b.translation();
      if (st === 'active') {
        const r = level.balls[i].radius;
        // A bigger ball parked on a smaller green hole blocks it: tell the game once it has stayed there for a moment.
        const bcls = level.balls[i].cls;
        const sv = b.linvel();
        const slow = Math.hypot(sv.x, sv.y, sv.z) < 0.7;
        let over = false;
        if (slow) for (const t of level.trays) {
          if (Math.abs(p.y - (t.cy + PLATE_T / 2 + r)) > 0.35) continue;
          if (t.holes.some((q) => q.kind === 'goal' && (q.cls ?? 0) < bcls && Math.hypot(p.x - q.x, p.z - q.z) < q.r + r * 0.4)) { over = true; break; }
        }
        this.blockT[i] = over ? (this.blockT[i] ?? 0) + FIXED_DT : 0;
        if (this.blockT[i] > 0.45 && this.elapsed - (this.blockedAt[i] ?? -99) > 8) { this.blockedAt[i] = this.elapsed; this.onEvent('blocked'); }
        for (const t of level.trays) {
          const under = t.cy - PLATE_T / 2 - r;
          if (p.y > under || p.y < under - FALL_BAND) continue;
          const bc = level.balls[i].cls;
          const h = t.holes.find((q) => Math.hypot(p.x - q.x, p.z - q.z) < q.r + 0.05 && (q.kind === 'trap' || (q.cls ?? 0) <= bc));
          if (!h) continue;
          this.status_[i] = h.kind === 'goal' ? 'collected' : 'lost';
          const cls = level.balls[i].cls;
          if (h.kind === 'goal') { this.collected++; this.classCollected[cls]++; }
          else {
            this.classLost[cls]++; this.lost++; this.lossLog.push({ ball: i, tray: t.index, how: 'trap', t: this.elapsed }); }
          this.onEvent(h.kind === 'goal' ? 'collected' : 'lost');
          break;
        }
        if (this.status_[i] === 'active' && p.y < level.abyssY + 6) {
          // Missed a tray entirely and fell into the void.
          this.status_[i] = 'lost';
          this.lost++;
          this.classLost[level.balls[i].cls]++;
          this.lossLog.push({ ball: i, tray: -1, how: 'void', t: this.elapsed });
          this.onEvent('lost');
        }
      }
      // Finished balls keep falling out of sight, then are switched off.
      if (this.status_[i] !== 'active' && p.y < Math.min(lastY, level.abyssY + 6) - 3) {
        b.setEnabled(false);
        this.hidden[i] = true;
      }
    });
  }

  private checkEnd() {
    const { classNeed, classAllowed } = this.level;
    if (classNeed.every((n, j) => this.classCollected[j] >= n)) {
      this.status = 'won';
      this.onEvent('won');
    } else if (classAllowed.some((a, j) => this.classLost[j] > a)) {
      this.status = 'failed';
      this.onEvent('failed');
    }
  }

  snapshot(): GameSnapshot {
    return {
      status: this.status,
      total: this.level.balls.length - this.status_.filter((s) => s === 'reserve').length,
      collected: this.collected,
      lost: this.lost,
      required: this.level.required,
      allowedLoss: this.level.allowedLoss,
      onBoard: this.level.balls.length - this.status_.filter((s) => s === 'reserve').length - this.collected - this.lost,
      lostTrap: this.lossLog.filter((l) => l.how === 'trap').length,
      lostVoid: this.lossLog.filter((l) => l.how === 'void').length,
      elapsed: this.elapsed,
      classes: this.level.classNeed.map((need, j) => ({ collected: this.classCollected[j], lost: this.classLost[j], need, allowed: this.level.classAllowed[j] })),
    };
  }

  dispose() {
    this.phys.dispose();
  }
}
