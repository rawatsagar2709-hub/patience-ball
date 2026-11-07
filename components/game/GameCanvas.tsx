'use client';
import { useRef, useState, type MutableRefObject, type PointerEvent, type WheelEvent } from 'react';
import { Canvas } from '@react-three/fiber';
import FpsGovernor from './FpsGovernor';
import type { GameSettings, GameSnapshot, Level } from '@/lib/types';
import GameScene, { type GameController } from './GameScene';

interface Props {
  level: Level;
  attempt: number;
  paused: boolean;
  settings: GameSettings;
  controllerRef: MutableRefObject<GameController | null>;
  onSnapshot: (s: GameSnapshot) => void;
}

type Mode = 'tilt' | 'orbit';

/** Drag the board to tip it; drag the empty background (or use two fingers, right mouse, shift+drag) to turn the view; pinch or wheel zooms. */
export default function GameCanvas(props: Props) {
  const [dpr, setDpr] = useState(() => {
    if (typeof window === 'undefined') return 1.5;
    // Weaker devices (4 cores or fewer) start a notch lower; the governor still raises it if frames allow.
    const cap = (navigator.hardwareConcurrency || 8) <= 4 ? 1.4 : 1.75;
    return Math.min(cap, window.devicePixelRatio || 1);
  });
  const maxDpr = useRef(dpr);
  const declines = useRef(0);
  const [shadows, setShadows] = useState(true);
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ x: number; y: number; bx: number; bz: number } | null>(null);
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const mode = useRef<Mode>('tilt');
  const ctl = () => props.controllerRef.current;

  const pair = () => {
    const [a, b] = [...pts.current.values()];
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.current.size >= 2) {
      mode.current = 'orbit';
      start.current = null;
    } else if (e.button === 2 || e.shiftKey || ctl()?.hitsBoard(e.clientX, e.clientY) === false) {
      mode.current = 'orbit';
    } else {
      mode.current = 'tilt';
      const [bx, bz] = ctl()?.getPointer() ?? [0, 0];
      start.current = { x: e.clientX, y: e.clientY, bx, bz };
    }
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const prev = pts.current.get(e.pointerId);
    if (!prev) return;
    const before = pts.current.size >= 2 ? pair() : null;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (before) {
      const now = pair();
      ctl()?.orbit(-(now.mx - before.mx) * 0.009, (now.my - before.my) * 0.006);
      ctl()?.zoomBy(before.d / now.d);
    } else if (mode.current === 'orbit') {
      ctl()?.orbit(-(e.clientX - prev.x) * 0.009, (e.clientY - prev.y) * 0.006);
    } else if (start.current) {
      const reach = Math.max(80, Math.min(window.innerWidth, window.innerHeight) * 0.2) / (props.settings.sensitivity || 1);
      const clamp = (v: number) => Math.max(-1, Math.min(1, v));
      ctl()?.setPointer(clamp(start.current.bx + (e.clientX - start.current.x) / reach), clamp(start.current.bz + (e.clientY - start.current.y) / reach));
    }
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    pts.current.delete(e.pointerId);
    if (pts.current.size === 0) {
      // The board stays tilted where you left it. A quick double tap levels it again.
      const s = start.current;
      if (s && mode.current === 'tilt' && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 8) {
        const now = performance.now();
        const l = lastTap.current;
        if (now - l.t < 320 && Math.hypot(e.clientX - l.x, e.clientY - l.y) < 30) { ctl()?.setPointer(0, 0); lastTap.current = { t: 0, x: 0, y: 0 }; }
        else lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      }
      start.current = null;
      mode.current = 'tilt';
    }
  };
  const wheel = (e: WheelEvent<HTMLDivElement>) => ctl()?.zoomBy(e.deltaY > 0 ? 1.1 : 0.9);

  return (
    <div
      style={{ position: 'absolute', inset: 0, touchAction: 'none', cursor: 'grab' }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onWheel={wheel}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Game board. Drag it to tilt. Drag the background to rotate the view."
    >
      <Canvas
        shadows={shadows}
        frameloop={props.paused ? 'demand' : 'always'} /* no drawing behind the pause screen: saves battery */
        dpr={[1, dpr]}
        camera={{ fov: 38, near: 0.5, far: 400, position: [0, 20, 30] }}
        gl={{ alpha: true, antialias: dpr < 1.5, powerPreference: 'high-performance' }}
      >
        <FpsGovernor
          onDecline={() => {
            // Shed load step by step: lower resolution first, then shadows.
            declines.current++;
            setDpr((d) => Math.max(1, d - 0.35));
            if (declines.current >= 2) setShadows(false);
          }}
          onIncline={() => setDpr((d) => Math.min(maxDpr.current, d + 0.25))}
        />
        <GameScene {...props} />
      </Canvas>
    </div>
  );
}
