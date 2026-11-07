'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import StudioEnv from './StudioEnv';
import * as THREE from 'three';
import { skinOf } from '@/lib/skins';
import { PLATE_T } from '@/lib/levels/geometry';
import type { GameSettings, GameSnapshot, Level } from '@/lib/types';
import { BALL_COLORS, THEMES, colorSlot } from '@/lib/themes';
import { FIXED_DT, loadRapier } from '@/lib/physics/physicsWorld';
import { Simulation, type SimEvent } from '@/lib/physics/simulation';
import { haptic, playClip, preloadClips, sound } from '@/lib/audio/audioManager';
import TrayMesh from './Tray';
import { isMover } from '@/lib/physics/physicsWorld';
import { hazardTexture } from './materials';
import CameraController, { DEFAULT_EL, MIN_EL, TOP_EL, defaultView, type ViewState } from './CameraController';

/** Input sources are summed, so keys, a drag and phone tilt can all steer the board. */
const TRAIL = 36;
/** True while the ball that would win the level is rolling up to a goal hole. */
function lastBallNear(sim: Simulation, level: Level) {
  if (sim.status !== 'playing' || sim.collected !== level.required - 1) return false;
  for (let i = 0; i < level.balls.length; i++) {
    if (sim.isHidden(i)) continue;
    const p = sim.phys.balls[i].translation();
    for (const t of level.trays) {
      if (Math.abs(p.y - t.cy) > 1.5) continue;
      for (const h of t.holes) if (h.kind === 'goal' && Math.hypot(p.x - h.x, p.z - h.z) < h.r + 1.2) return true;
    }
  }
  return false;
}
export interface GameController {
  setPointer(x: number, z: number): void;
  /** Current drag tilt, which the board keeps after you let go. */
  getPointer(): [number, number];
  /** Total tilt in [-1, 1] per axis, from drag, keys and gyroscope. */
  getTilt(): [number, number];
  /** Spend an ability inside the running level; false when it cannot be used now. */
  useAbility(key: 'extra' | 'home' | 'freeze' | 'slow'): boolean;
  setKeys(x: number, z: number): void;
  setDevice(x: number, z: number): void;
  resetCamera(): void;
  /** Turn the view by quarter-steps (-1 left, +1 right). */
  rotate(dir: -1 | 1): void;
  /** Free orbit by radians. */
  orbit(dAz: number, dEl: number): void;
  zoomBy(factor: number): void;
  toggleTop(): void;
  /** True when a screen point is over the board (drag tilts), false over empty background (drag turns the view). */
  hitsBoard(clientX: number, clientY: number): boolean;
}

interface Props {
  level: Level;
  /** Bump to restart the same level. */
  attempt: number;
  paused: boolean;
  settings: GameSettings;
  controllerRef: MutableRefObject<GameController | null>;
  onSnapshot: (s: GameSnapshot) => void;
}

export default function GameScene({ level, attempt, paused, settings, controllerRef, onSnapshot }: Props) {
  const theme = THEMES[level.theme % THEMES.length];
  const simRef = useRef<Simulation | null>(null);
  const acc = useRef(0);
  const skin = skinOf(settings.skin);
  const marbles = useRef<THREE.InstancedMesh>(null);
  const streak = useRef(0);
  const lastCup = useRef(0);
  const lastHappy = useRef(0);
  const lastLaugh = useRef(0);
  const slowLeft = useRef(0); // seconds of slow motion left (ability)
  const trail = useRef<THREE.InstancedMesh>(null);
  const trailLife = useRef(new Float32Array(TRAIL));
  const trailPos = useRef(new Float32Array(TRAIL * 4)); // x, y, z, radius
  const trailHead = useRef(0);
  const hintAt = useRef({ last: 0, next: 0 }); // idle hint: flash the goals when nothing has been collected for a while
  const lastBump = useRef(0);
  const doorOpen = useRef<Record<number, boolean>>({});
  const doorBars = useRef<Record<number, THREE.Mesh | null>>({});
  const doorList = useMemo(() => level.trays.flatMap((t) => t.obstacles.filter((o): o is Extract<typeof o, { kind: 'door' }> => o.kind === 'door').map((o) => ({ o, top: t.cy + PLATE_T / 2 }))), [level]);
  const board = useRef<THREE.Group>(null);
  const input = useRef({ ptr: [0, 0], key: [0, 0], dev: [0, 0] });
  const { camera, gl } = useThree();
  const view = useRef<ViewState>({ target: defaultView(), cur: { ...defaultView(), zoom: 1.3 } });
  const runId = `${level.seed}-${level.levelNumber}-${attempt}`;
  const settingsRef = useRef(settings);
  const snapCb = useRef(onSnapshot);
  useEffect(() => { settingsRef.current = settings; snapCb.current = onSnapshot; }, [settings, onSnapshot]);

  const center = useMemo(() => {
    const { min, max } = level.bounds;
    return new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  }, [level]);

  useEffect(() => {
    let cancelled = false;
    let sim: Simulation | null = null;
    acc.current = 0;
    input.current.ptr = [0, 0]; // every run starts with a flat board
    loadRapier().then((R) => {
      if (cancelled) return;
      preloadClips();
      sim = new Simulation(R, level);
      simRef.current = sim;
      const push = () => snapCb.current(sim!.snapshot());
      sim.onEvent = (e: SimEvent) => {
        const st = settingsRef.current;
        if (e === 'collected') {
          const now = performance.now();
          streak.current = now - lastCup.current < 1600 ? streak.current + 1 : 1;
          lastCup.current = now;
          sound.cup(streak.current);
          if (streak.current === 3 && now - lastHappy.current > 4000) { lastHappy.current = now; playClip('happy'); }
          hintAt.current.last = sim!.elapsed;
          window.dispatchEvent(new Event('pb-cup'));
          haptic(streak.current > 1 ? [15, 30, 25] : 15, st.haptics);
          if (streak.current > 1) window.dispatchEvent(new CustomEvent('pb-combo', { detail: streak.current }));
        }
        else if (e === 'lost') {
          // A red hole gets a laugh (not more than one every 1.5 s); a ball lost off the edge keeps the plain tone.
          if (sim!.lossLog[sim!.lossLog.length - 1]?.how === 'trap') { const now = performance.now(); if (now - lastLaugh.current > 1500) { lastLaugh.current = now; playClip('laugh'); } }
          else sound.lose();
          haptic(30, st.haptics);
        }
        else if (e === 'blocked') playClip('evil');
        else if (e === 'won') { sound.win(); haptic([30, 40, 60], st.haptics); }
        else if (e === 'failed') playClip('meow', 1, true);
        else if (e === 'portal') sound.portal();
        else if (e === 'bump') {
          const now = performance.now();
          if (now - lastBump.current > 90) { lastBump.current = now; sound.bump(); haptic(8, st.haptics); }
          return; // no HUD refresh needed for a bump
        }
        push();
      };
      push();
    });
    return () => {
      cancelled = true;
      simRef.current = null;
      sim?.dispose();
    };
    // The level + attempt define a run; callbacks are read through refs so they never restart it.
  }, [level, attempt]);

  useEffect(() => {
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const QUARTER = Math.PI / 4;
    controllerRef.current = {
      setPointer: (x, z) => { input.current.ptr = [x, z]; },
      getPointer: () => [input.current.ptr[0], input.current.ptr[1]],
      getTilt: () => { const i = input.current; return [Math.max(-1, Math.min(1, i.ptr[0] + i.key[0] + i.dev[0])), Math.max(-1, Math.min(1, i.ptr[1] + i.key[1] + i.dev[1]))]; },
      useAbility: (key) => {
        const sim = simRef.current;
        if (!sim || sim.status !== 'playing') return false;
        if (key === 'extra') return sim.addReserve();
        if (key === 'home') return sim.sendHome();
        if (key === 'freeze') { sim.freeze = 8; return true; }
        slowLeft.current = 8;
        return true;
      },
      setKeys: (x, z) => { input.current.key = [x, z]; },
      setDevice: (x, z) => { input.current.dev = [x, z]; },
      resetCamera: () => { view.current.target = defaultView(); },
      rotate: (dir) => { const t = view.current.target; t.az = Math.round(t.az / QUARTER + dir) * QUARTER; },
      orbit: (dAz, dEl) => { const t = view.current.target; t.az += dAz; t.el = clamp(t.el + dEl, MIN_EL, TOP_EL); },
      zoomBy: (f) => { const t = view.current.target; t.zoom = clamp(t.zoom * f, 0.5, 1.5); },
      hitsBoard: (cx, cy) => {
        if (!board.current) return true;
        const r = gl.domElement.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
        return ray.intersectObject(board.current, true).length > 0;
      },
      toggleTop: () => { const t = view.current.target; t.el = t.el > (DEFAULT_EL + TOP_EL) / 2 ? DEFAULT_EL : TOP_EL; },
    };
    return () => { controllerRef.current = null; };
  }, [controllerRef, camera, gl]);

  // Per-ball colour by size class.
  useLayoutEffect(() => {
    const mesh = marbles.current;
    if (!mesh) return;
    const c = new THREE.Color();
    level.balls.forEach((b, i) => mesh.setColorAt(i, c.set(BALL_COLORS[colorSlot(level, b.cls)])));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [level, runId]);

  const movers = useMemo(() => level.trays.flatMap((t) => t.obstacles.filter(isMover)), [level]);
  const moverRefs = useRef<Array<THREE.Object3D | null>>([]);
  const hazard = useMemo(() => hazardTexture(), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((_, dt) => {
    const sim = simRef.current;
    if (sim) {
      // Tilt input is relative to the screen, so turn it by however far the camera has orbited.
      const i = input.current;
      const k = settingsRef.current.assist ? 0.7 : 1; // gentle tilt
      const x = (i.ptr[0] + i.key[0] + i.dev[0]) * k;
      const z = (i.ptr[1] + i.key[1] + i.dev[1]) * k;
      const a = view.current.cur.az;
      sim.setInput(x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a));
    }
    if (sim && !paused) {
      if (slowLeft.current > 0) slowLeft.current = Math.max(0, slowLeft.current - dt);
      acc.current += Math.min(dt, 1 / 30) * (slowLeft.current > 0 ? 0.5 : 1) * (lastBallNear(sim, level) ? 0.45 : 1); // slow-motion as the winning ball reaches a goal; // below 30 fps the game slows down instead of piling up physics work
      while (acc.current >= FIXED_DT) {
        sim.step();
        acc.current -= FIXED_DT;
      }
    }
    if (board.current && sim) board.current.quaternion.copy(sim.quat);
    if (sim && !paused && sim.status === 'playing') {
      const h = hintAt.current;
      if (sim.elapsed < h.last) h.last = 0;
      if (sim.elapsed - h.last > 14 && sim.elapsed > h.next) { h.next = sim.elapsed + 3; window.dispatchEvent(new Event('pb-cup')); }
    }
    if (sim) {
      sim.phys.movers.forEach((s, i) => {
        const m = moverRefs.current[i];
        if (!m) return;
        const p = s.body.translation();
        const q = s.body.rotation();
        m.position.set(p.x, p.y, p.z);
        m.quaternion.set(q.x, q.y, q.z, q.w);
        if (s.o.kind === 'door') {
          // Telegraph: the door flashes in the last second before it closes and before it opens, so the timing is readable.
          const d = s.o, P = d.open + d.closed, ph = (((sim.moverClock + d.offset) % P) + P) % P;
          const isOpen = ph < d.open;
          if (doorOpen.current[d.id] !== undefined && doorOpen.current[d.id] !== isOpen) sound.door(isOpen);
          doorOpen.current[d.id] = isOpen;
          const warn = ph < d.open ? d.open - ph < 1.1 : P - ph < 1.1;
          const mat = (m.children[0] as THREE.Mesh | undefined)?.material as THREE.MeshStandardMaterial | undefined;
          if (mat) mat.emissiveIntensity = warn ? 1.2 + 1.2 * Math.sin(sim.elapsed * 18) : ph < d.open ? 0.25 : 0.7;
          // Countdown bar: it shrinks over the open time (green) and over the closed time (red).
          const bar = doorBars.current[d.id];
          if (bar) {
            const left = ph < d.open ? (d.open - ph) / d.open : (P - ph) / d.closed;
            bar.scale.set(d.hx > d.hz ? Math.max(0.001, left) : 1, 1, d.hx > d.hz ? 1 : Math.max(0.001, left));
            (bar.material as THREE.MeshBasicMaterial).color.set(ph < d.open ? '#5dffb0' : '#ff6b87');
          }
        }
        if (s.o.kind === 'gate') {
          // Telegraph: the gate pulses while it is changing direction (about to rise or sink).
          const g = s.o, wave = Math.sin(g.speed * sim.moverClock + g.phase);
          const mat = (m.children[0] as THREE.Mesh | undefined)?.material as THREE.MeshStandardMaterial | undefined;
          if (mat) { mat.emissive.set('#ff7a00'); mat.emissiveIntensity = Math.abs(wave) < 0.3 ? 0.6 + 0.6 * Math.sin(sim.elapsed * 14) : 0; }
        }
      });
    }
    const mesh = marbles.current;
    if (mesh) {
      for (let i = 0; i < level.balls.length; i++) {
        if (sim && !sim.isHidden(i)) {
          const b = sim.phys.balls[i];
          const p = b.translation();
          const q = b.rotation();
          dummy.position.set(p.x, p.y, p.z);
          dummy.quaternion.set(q.x, q.y, q.z, q.w);
          dummy.scale.setScalar(level.balls[i].radius);
        } else dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    // Speed trail: fast balls leave a short fading streak.
    const tr = trail.current;
    if (tr && sim && !settingsRef.current.reducedMotion) {
      const life = trailLife.current, pos = trailPos.current;
      if (!paused) {
        let spawned = 0;
        for (let i = 0; i < level.balls.length && spawned < 3; i++) {
          if (sim.isHidden(i)) continue;
          const v = sim.phys.balls[i].linvel();
          if (v.x * v.x + v.y * v.y + v.z * v.z < 100) continue;
          const p = sim.phys.balls[i].translation(), k = trailHead.current++ % TRAIL;
          pos[k * 4] = p.x; pos[k * 4 + 1] = p.y; pos[k * 4 + 2] = p.z; pos[k * 4 + 3] = level.balls[i].radius;
          life[k] = 1; spawned++;
        }
        for (let k = 0; k < TRAIL; k++) life[k] = Math.max(0, life[k] - dt * 3.5);
      }
      for (let k = 0; k < TRAIL; k++) {
        dummy.position.set(pos[k * 4], pos[k * 4 + 1], pos[k * 4 + 2]);
        dummy.quaternion.identity();
        dummy.scale.setScalar(pos[k * 4 + 3] * 0.55 * life[k]);
        dummy.updateMatrix();
        tr.setMatrixAt(k, dummy.matrix);
      }
      tr.instanceMatrix.needsUpdate = true;
    }
  });

  const { min, max } = level.bounds;
  const span = Math.max(max[0] - min[0], max[2] - min[2], max[1] - min[1]);
  return (
    <>
      <CameraController level={level} reducedMotion={settings.reducedMotion} view={view} />
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[center.x + 8, center.y + 30, center.z + 16]}
        intensity={2.4}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-span * 0.75}
        shadow-camera-right={span * 0.75}
        shadow-camera-top={span * 0.75}
        shadow-camera-bottom={-span * 0.75}
        shadow-camera-near={1}
        shadow-camera-far={120}
        shadow-bias={-0.0006}
        target-position={[center.x, center.y, center.z]}
      />
      {/* Procedural reflections: no downloaded HDRI, so it works offline. */}
      <StudioEnv />


      {/* The whole board tips as one piece, about its centre. */}
      <group ref={board} position={center}>
        <group position={[-center.x, -center.y, -center.z]}>
          {level.trays.map((t) => (
            <TrayMesh key={t.index} tray={t} level={level} theme={theme} />
          ))}
          {doorList.map(({ o, top }) => {
            const long = Math.max(o.hx, o.hz) * 2;
            const alongX = o.hx > o.hz;
            return (
              <mesh key={`${runId}-bar-${o.id}`} ref={(b) => { doorBars.current[o.id] = b; }} position={[o.x + (alongX ? 0 : 0.5), top + 0.06, o.z + (alongX ? 0.5 : 0)]}>
                <boxGeometry args={[alongX ? long : 0.14, 0.06, alongX ? 0.14 : long]} />
                <meshBasicMaterial color="#5dffb0" toneMapped={false} />
              </mesh>
            );
          })}
          {movers.map((o, i) => (
            <group key={`${runId}-${o.id}`} ref={(m) => { moverRefs.current[i] = m; }} position={[o.x, 0, o.z]}>
              {o.kind === 'sweeper' && (
                <mesh castShadow receiveShadow>
                  <boxGeometry args={[o.hx * 2, level.wallHeight, o.hz * 2]} />
                  <meshStandardMaterial color="#c86bff" emissive="#8a1fe0" emissiveIntensity={0.55} roughness={0.35} metalness={0.3} />
                </mesh>
              )}
              {o.kind === 'gate' && (
                <mesh castShadow receiveShadow>
                  <boxGeometry args={[o.hx * 2, level.wallHeight, o.hz * 2]} />
                  <meshStandardMaterial map={hazard} roughness={0.5} metalness={0.2} />
                </mesh>
              )}
              {o.kind === 'door' && (
                <mesh castShadow receiveShadow>
                  <boxGeometry args={[o.hx * 2, level.wallHeight, o.hz * 2]} />
                  <meshStandardMaterial color="#ffb020" emissive="#ff7a00" emissiveIntensity={0.7} roughness={0.3} metalness={0.3} transparent opacity={0.88} />
                </mesh>
              )}
              {o.kind === 'spinner' && (
                <>
                  <mesh castShadow receiveShadow>
                    <boxGeometry args={[o.len * 2, level.wallHeight, 0.28]} />
                    <meshStandardMaterial color="#31e0ff" emissive="#0aa4c8" emissiveIntensity={0.6} roughness={0.3} metalness={0.4} />
                  </mesh>
                  <mesh castShadow receiveShadow>
                    <boxGeometry args={[0.28, level.wallHeight, o.len * 2]} />
                    <meshStandardMaterial color="#31e0ff" emissive="#0aa4c8" emissiveIntensity={0.6} roughness={0.3} metalness={0.4} />
                  </mesh>
                  <mesh position={[0, level.wallHeight / 2 + 0.05, 0]}>
                    <cylinderGeometry args={[0.32, 0.32, 0.12, 24]} />
                    <meshStandardMaterial color="#ffffff" emissive="#9ff3ff" emissiveIntensity={0.8} />
                  </mesh>
                </>
              )}
            </group>
          ))}
          <instancedMesh key={`${runId}-trail`} ref={trail} args={[undefined, undefined, TRAIL]} frustumCulled={false}>
            <sphereGeometry args={[1, 8, 6]} />
            <meshBasicMaterial color="#ffffff" transparent opacity={0.35} depthWrite={false} toneMapped={false} />
          </instancedMesh>
          <instancedMesh key={runId} ref={marbles} args={[undefined, undefined, level.balls.length]} frustumCulled={false} castShadow>
            <sphereGeometry args={[1, 28, 20]} />
            <meshPhysicalMaterial color="#ffffff" metalness={skin.metalness} roughness={skin.roughness} clearcoat={skin.clearcoat} clearcoatRoughness={0.08} envMapIntensity={1.8} />
          </instancedMesh>
        </group>
      </group>
    </>
  );
}
