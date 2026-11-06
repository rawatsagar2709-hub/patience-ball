'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { GameSettings, GameSnapshot, Level, SaveData } from '@/lib/types';
import { defaultSave } from '@/lib/types';
import { generateLevel, randomSeed } from '@/lib/levels/levelGenerator';
import { loadSave, resetSave, writeSave } from '@/lib/storage/saveManager';
import { setSoundEnabled, sound, startMusic, stopMusic } from '@/lib/audio/audioManager';
import { THEMES } from '@/lib/themes';
import type { GameController } from '@/components/game/GameScene';
import MainMenu from '@/components/ui/MainMenu';
import GameHUD from '@/components/ui/GameHUD';
import LevelSelect from '@/components/ui/LevelSelect';
import { bumpMission } from '@/lib/missions';
import { ABILITIES, bumpTask, claimSecret, readAbilities, spendAbility, type AbilityKey, type TaskKind } from '@/lib/abilities';
import { completeDaily, completeWeekly, currentStreak, dailyLevel, doneToday, weeklyDone, weeklyLevel } from '@/lib/daily';
import AwardToast from '@/components/ui/AwardToast';
import TipCard from '@/components/ui/TipCard';
import { markTipsSeen, newTips, tipsOf, type Tip } from '@/lib/tips';
import Tutorial from '@/components/ui/Tutorial';
import GameLoading from '@/components/ui/GameLoading';
import SettingsPanel from '@/components/ui/SettingsPanel';
import { CompletedOverlay, FailedOverlay, PauseOverlay, starsFor } from '@/components/ui/Overlays';

// Three.js + WASM physics only load on the client, after the menu is already showing.
const loadGame = () => import('@/components/game/GameCanvas');
const GameCanvas = dynamic(loadGame, { ssr: false });
const TUT_KEY = 'pb_tutorial_seen';
const tutSeen = () => { try { return localStorage.getItem(TUT_KEY) === '1'; } catch { return true; } };

const screen_angle = () => (typeof window !== 'undefined' && window.screen.orientation ? window.screen.orientation.angle : 0);

type Screen = 'menu' | 'game' | 'settings' | 'levels';

export default function Page() {
  const [save, setSave] = useState<SaveData>(defaultSave);
  const saveRef = useRef(save);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [award, setAward] = useState<{ key: AbilityKey; live: boolean } | null>(null); // a freshly earned ability
  const [screen, setScreen] = useState<Screen>('menu');
  const [stale, setStale] = useState(false); // a newer version is live
  const [level, setLevel] = useState<Level | null>(null);
  const [random, setRandom] = useState(false);
  const [daily, setDaily] = useState(false);
  const [weekly, setWeekly] = useState(false);
  const [practice, setPractice] = useState(false); // no-risk run: only one ball per size is needed, nothing is saved
  const [installEvt, setInstallEvt] = useState<{ prompt: () => Promise<void> } | null>(null);
  useEffect(() => {
    const on = (e: Event) => { e.preventDefault(); setInstallEvt(e as unknown as { prompt: () => Promise<void> }); };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  const [assist, setAssist] = useState(0); // extra spare balls after repeated fails (normal levels only)
  const [fails, setFails] = useState(0); // fails on the current level; resets when another level starts
  const [bestInfo, setBestInfo] = useState<{ prev: number | null; secs: number } | null>(null);
  const [dayStreak, setDayStreak] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [abTick, setAbTick] = useState(0);
  const [usedAb, setUsedAb] = useState<{ key: string; used: AbilityKey[] }>({ key: '', used: [] });
  const practiceRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [tutorial, setTutorial] = useState(false);
  const [splash, setSplash] = useState(true);
  useEffect(() => {
    const earn = (kind: TaskKind) => {
      if (practiceRef.current) return;
      const won = bumpTask(kind);
      if (won.length) { setAward({ key: won[0], live: true }); setAbTick((t) => t + 1); }
    };
    const cup = () => { bumpMission('balls'); earn('balls'); };
    const combo = (e: Event) => { if ((e as CustomEvent<number>).detail >= 3) { bumpMission('combo'); earn('combo'); } };
    window.addEventListener('pb-cup', cup);
    window.addEventListener('pb-combo', combo);
    return () => { window.removeEventListener('pb-cup', cup); window.removeEventListener('pb-combo', combo); };
  }, []);
  useEffect(() => { const t = setTimeout(() => setSplash(false), 1100); return () => clearTimeout(t); }, []);
  const [tips, setTips] = useState<Tip[]>([]);
  const [snap, setSnap] = useState<GameSnapshot | null>(null);
  const controller = useRef<GameController | null>(null);
  const finished = useRef(false);
  const ctl = useCallback(() => controller.current, []);

  const commit = useCallback((next: SaveData) => {
    saveRef.current = next;
    setSave(next);
    setSoundEnabled(next.settings.sound);
    void writeSave(next).then((ok) => ok || setNotice('Could not save progress on this device. Your game still works, but progress may be lost on refresh.'));
  }, []);

  useEffect(() => {
    loadSave().then(({ data, recovered }) => {
      saveRef.current = data;
      setSave(data);
      setSoundEnabled(data.settings.sound);
      setLoaded(true);
      if (recovered) setNotice('Saved progress could not be read, so a fresh save was started.');
    });
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    // Ask the server which build is live; when it differs from this one, flag the app for a reload.
    const check = () => {
      if (!navigator.onLine) return;
      fetch('/api/version', { cache: 'no-store' }).then((r) => r.json()).then((d) => { if (d.v && d.v !== process.env.NEXT_PUBLIC_BUILD_ID) setStale(true); }).catch(() => {});
    };
    const onVis = () => { if (document.visibilityState === 'visible') check(); };
    check();
    const timer = setInterval(check, 5 * 60 * 1000);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(timer); window.removeEventListener('online', check); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // Reload for the update only between levels, never in the middle of a run.
  useEffect(() => {
    if (!stale || screen === 'game') return;
    // Guard against a reload loop (e.g. servers briefly on different builds): at most one automatic reload per minute.
    try { const last = Number(sessionStorage.getItem('pb_reload') || 0); if (Date.now() - last < 60000) return; sessionStorage.setItem('pb_reload', String(Date.now())); } catch {}
    navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {}).finally(() => window.location.reload());
  }, [stale, screen]);

  // The 3D engine and physics are ~2.6 MB: fetch and compile them in the background while the menu is showing.
  useEffect(() => {
    if (!loaded) return;
    // Skip the background download on data-saver or slow connections; the game then loads when Play is pressed.
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn?.saveData || /^(slow-2g|2g|3g)$/.test(conn?.effectiveType ?? '')) return;
    const warm = () => { void loadGame(); void import('@/lib/physics/physicsWorld').then((m) => m.loadRapier()); };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(warm, { timeout: 1500 }); else setTimeout(warm, 1200);
  }, [loaded]);

  const finishTutorial = useCallback(() => { try { localStorage.setItem(TUT_KEY, '1'); } catch {} setTutorial(false); }, []);

  const start = useCallback((n: number, seed?: number, isRandom = false, withTutorial = false, isDaily = false, isWeekly = false) => {
    if (withTutorial || (n === 1 && !isRandom && !tutSeen() && saveRef.current.stats.levelsCompleted === 0)) setTutorial(true);
    const lv = generateLevel(n, seed);
    finished.current = false;
    setLevel(lv);
    setTips(newTips(lv));
    setRandom(isRandom);
    setDaily(isDaily);
    setWeekly(isWeekly);
    setPractice(false);
    setFails(0);
    setAssist(0);
    setBestInfo(null);
    setSnap(null);
    setPaused(false);
    setAttempt((a) => a + 1);
    setScreen('game');
    const s = saveRef.current;
    commit({ ...s, currentLevel: isRandom ? s.currentLevel : n, checkpoint: { levelNumber: n, seed: lv.seed, random: isRandom }, stats: { ...s.stats, attempts: s.stats.attempts + 1 } });
  }, [commit]);

  // A shared challenge link (?c=level.seed) opens that exact level once the save has loaded.
  const challengeOpened = useRef(false);
  useEffect(() => {
    if (!loaded || challengeOpened.current) return;
    challengeOpened.current = true;
    const m = /^(\d{1,3})\.(\d{1,10})$/.exec(new URLSearchParams(location.search).get('c') ?? '');
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    setTimeout(() => start(Math.max(1, Math.min(200, Number(m[1]))), Number(m[2]) >>> 0, true), 0);
  }, [loaded, start]);

  const playWeekly = () => { const d = weeklyLevel(); start(d.n, d.seed, true, false, false, true); };
  const playDaily = () => { const d = dailyLevel(); start(d.n, d.seed, true, false, true); };
  const playRandom = () => start(1 + Math.floor(Math.random() * Math.max(8, saveRef.current.highestUnlocked + 4)), randomSeed(), true);

  const restart = useCallback(() => {
    if (!level) return;
    finished.current = false;
    setSnap(null);
    setPaused(false);
    setAssist(random ? 0 : Math.min(2, Math.floor(fails / 2)));
    setAttempt((a) => a + 1);
    const s = saveRef.current;
    commit({ ...s, stats: { ...s.stats, attempts: s.stats.attempts + 1 } });
  }, [level, commit, random, fails]);

  // After 20 fails on the same level the player may move on: the next level unlocks, but this one stays uncompleted (no stars).
  const skipLevel = useCallback(() => {
    if (!level) return;
    const s = saveRef.current, n = level.levelNumber;
    commit({ ...s, highestUnlocked: Math.max(s.highestUnlocked, n + 1), currentLevel: n + 1 });
    start(n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, commit]);

  const onSnapshot = useCallback((s: GameSnapshot) => {
    setSnap(s);
    if (s.status === 'playing' || finished.current) return;
    finished.current = true;
    if (s.status === 'failed') setFails((f) => f + 1);
    if (s.status === 'won') {
      bumpMission('wins');
      if (!practice) {
        const won = [...bumpTask('wins'), ...(starsFor(s.lost, s.allowedLoss) === 3 ? bumpTask('stars3') : [])];
        if (won.length) { setAward({ key: won[0], live: false }); setAbTick((t) => t + 1); }
      }
    }
    const cur = saveRef.current;
    const stats = { ...cur.stats, ballsPlayed: cur.stats.ballsPlayed + s.total, ballsCollected: cur.stats.ballsCollected + s.collected };
    const mile = [100, 250, 500, 1000, 2500, 5000].find((m) => cur.stats.ballsCollected < m && stats.ballsCollected >= m);
    if (mile) setNotice(`Milestone: ${mile.toLocaleString()} balls brought home`);
    if (s.status === 'won' && level && !random && !practice) {
      const n = level.levelNumber;
      const best = cur.bestTimes[n];
      const secs = Math.round(s.elapsed);
      setBestInfo({ prev: best ?? null, secs });
      commit({
        ...cur,
        stats: { ...stats, levelsCompleted: cur.stats.levelsCompleted + (cur.completedLevels.includes(n) ? 0 : 1) },
        completedLevels: cur.completedLevels.includes(n) ? cur.completedLevels : [...cur.completedLevels, n],
        highestUnlocked: Math.max(cur.highestUnlocked, n + 1),
        currentLevel: n + 1,
        bestTimes: { ...cur.bestTimes, [n]: best ? Math.min(best, secs) : secs },
        stars: { ...cur.stars, [n]: Math.max(cur.stars[n] ?? 0, starsFor(s.lost, s.allowedLoss)) },
        checkpoint: null,
      });
    } else {
      if (s.status === 'won' && daily) setDayStreak(completeDaily());
      if (s.status === 'won' && weekly) { completeWeekly(); setDayStreak((n) => n + 0.001); }
      commit({ ...cur, stats });
    }
  }, [level, random, daily, weekly, practice, commit]);

  // Count play time only while actually playing and visible.
  useEffect(() => {
    if (screen !== 'game' || paused || snap?.status !== 'playing') return;
    const id = setInterval(() => {
      if (document.hidden) return;
      const s = saveRef.current;
      saveRef.current = { ...s, stats: { ...s.stats, playSeconds: s.stats.playSeconds + 1 } };
    }, 1000);
    return () => clearInterval(id);
  }, [screen, paused, snap?.status]);

  // Pause when the tab is hidden.
  useEffect(() => {
    const f = () => { if (document.hidden) setPaused(true); };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);

  const toMenu = useCallback(() => { setPaused(false); setScreen('menu'); }, []);
  const nextLevel = useCallback(() => {
    if (daily || weekly) toMenu();
    else if (random) playRandom();
    else start((level?.levelNumber ?? 0) + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [random, daily, weekly, level, start, toMenu]);

  // Keyboard: arrows/WASD tip the board while held; shortcuts for the rest.
  useEffect(() => {
    if (screen !== 'game') return;
    const held = new Set<string>();
    const sync = () => {
      const k = (a: string, b: string) => (held.has(a) || held.has(a.toUpperCase()) ? -1 : 0) + (held.has(b) || held.has(b.toUpperCase()) ? 1 : 0);
      const x = (held.has('ArrowLeft') ? -1 : 0) + (held.has('ArrowRight') ? 1 : 0) + k('a', 'd');
      const z = (held.has('ArrowUp') ? -1 : 0) + (held.has('ArrowDown') ? 1 : 0) + k('w', 's');
      controller.current?.setKeys(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, z)));
    };
    const tilt = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'd', 'w', 's', 'A', 'D', 'W', 'S'];
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (tilt.includes(e.key)) { e.preventDefault(); held.add(e.key); sync(); return; }
      switch (e.key) {
        case 'r': case 'R': restart(); break;
        case 'p': case 'P': case 'Escape': setPaused((v) => !v); break;
        case 'f': case 'F': case ' ': controller.current?.setPointer(0, 0); break;
        case 'c': case 'C': controller.current?.resetCamera(); break;
        case 'q': case 'Q': controller.current?.rotate(-1); break;
        case 'e': case 'E': controller.current?.rotate(1); break;
        case '+': case '=': controller.current?.zoomBy(0.85); break;
        case '-': controller.current?.zoomBy(1.18); break;
        case 't': case 'T': controller.current?.toggleTop(); break;
        case 'n': case 'N': if (snap?.status === 'won') nextLevel(); break;
        case 'm': case 'M': commit({ ...saveRef.current, settings: { ...saveRef.current.settings, sound: !saveRef.current.settings.sound } }); break;
      }
    };
    const up = (e: KeyboardEvent) => { if (held.delete(e.key)) sync(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      ctl()?.setKeys(0, 0);
    };
  }, [screen, snap?.status, restart, nextLevel, commit, ctl]);

  // Gyroscope: leaning the phone tips the board. A setting (Settings or the in-game button); iOS needs a permission tap.
  const canTiltPhone = useSyncExternalStore(
    () => () => {},
    () => 'DeviceOrientationEvent' in window && window.matchMedia('(pointer: coarse)').matches,
    () => false,
  );
  const phoneTilt = save.settings.gyro && canTiltPhone;
  const sens = save.settings.sensitivity;
  const calibrate = useRef<() => void>(() => {});
  useEffect(() => {
    if (!phoneTilt || screen !== 'game') return;
    let base: { x: number; z: number } | null = null;
    let sx = 0, sz = 0, last: { x: number; z: number } | null = null;
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const on = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      // Rotate the readings into screen terms so it also works with the phone turned sideways.
      const a = ((screen_angle() % 360) + 360) % 360;
      const x = a === 90 ? e.beta : a === 270 ? -e.beta : a === 180 ? -e.gamma : e.gamma;
      const z = a === 90 ? -e.gamma : a === 270 ? e.gamma : a === 180 ? -e.beta : e.beta;
      last = { x, z };
      base ??= last; // the angle you hold the phone at when the level starts is "flat"
      // Light smoothing keeps hand shake from jittering the board; a small dead zone lets it rest flat.
      const dz = (v: number) => (Math.abs(v) < 0.04 ? 0 : v);
      sx += (clamp(((x - base.x) / 22) * sens) - sx) * 0.35;
      sz += (clamp(((z - base.z) / 22) * sens) - sz) * 0.35;
      controller.current?.setDevice(dz(sx), dz(sz));
    };
    calibrate.current = () => { if (last) base = last; };
    window.addEventListener('deviceorientation', on);
    return () => {
      window.removeEventListener('deviceorientation', on);
      calibrate.current = () => {};
      ctl()?.setDevice(0, 0);
    };
  }, [phoneTilt, screen, sens, ctl, attempt]);
  const setGyro = async (on: boolean) => {
    if (!on) return commit({ ...saveRef.current, settings: { ...saveRef.current.settings, gyro: false } });
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if (DOE.requestPermission && (await DOE.requestPermission()) !== 'granted') return setNotice('Motion access was not allowed, so drag the screen to tilt instead.');
      commit({ ...saveRef.current, settings: { ...saveRef.current.settings, gyro: true } });
    } catch {
      setNotice('Gyroscope is not available here, so drag the screen to tilt instead.');
    }
  };
  const togglePhoneTilt = () => void setGyro(!phoneTilt);

  // Read after hydration (loaded) so the server and first client render agree.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dailyInfo = useMemo(() => (loaded ? { done: doneToday(), streak: currentStreak(), weeklyDone: weeklyDone() } : { done: false, streak: 0, weeklyDone: false }), [loaded, screen, dayStreak]);

  // Spare balls after repeated fails: quietly more forgiving, never fewer than one ball needed per size.
  // The spare balls are decided when a run starts (not when the stock changes), so using the ability never restarts the level.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasExtra = useMemo(() => screen === 'game' && readAbilities().stock.extra > 0, [level, attempt, screen]);
  const playLevel = useMemo(() => {
    if (level && hasExtra && !practice) {
      const extra = Array.from({ length: 3 }, () => ({ radius: level.classRadii[0], cls: 0 }));
      const base = assist === 0 ? level : (() => { const allowed = level.classAllowed.map((a, j) => (level.classNeed[j] - assist >= 1 ? a + assist : a)); const need = level.classNeed.map((n, j) => n - (allowed[j] - level.classAllowed[j])); return { ...level, classAllowed: allowed, classNeed: need, required: need.reduce((a, b) => a + b, 0), allowedLoss: allowed.reduce((a, b) => a + b, 0) }; })();
      return { ...base, balls: [...level.balls, ...extra], reserve: 3 };
    }
    if (level && practice) {
      const allowed = level.classAllowed.map((a, j) => a + level.classNeed[j] - 1);
      return { ...level, classAllowed: allowed, classNeed: level.classNeed.map(() => 1), required: level.classNeed.length, allowedLoss: allowed.reduce((a, b) => a + b, 0) };
    }
    if (!level || assist === 0) return level;
    const allowed = level.classAllowed.map((a, j) => (level.classNeed[j] - assist >= 1 ? a + assist : a));
    const need = level.classNeed.map((n, j) => n - (allowed[j] - level.classAllowed[j]));
    return { ...level, classAllowed: allowed, classNeed: need, required: need.reduce((a, b) => a + b, 0), allowedLoss: allowed.reduce((a, b) => a + b, 0) };
  }, [level, assist, practice, hasExtra]);
  useEffect(() => { practiceRef.current = practice; }, [practice]);
  const runKey = `${level?.seed}-${level?.levelNumber}-${attempt}`;
  const used = usedAb.key === runKey ? usedAb.used : [];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stock = useMemo(() => (loaded ? readAbilities().stock : { extra: 0, home: 0, freeze: 0, slow: 0 }), [loaded, screen, abTick, usedAb]);
  const fireAbility = (k: AbilityKey) => {
    if (used.includes(k) || readAbilities().stock[k] <= 0) return;
    if (!controller.current?.useAbility(k)) { setNotice(k === 'extra' ? 'Spare balls are only available if you own the ability when the level starts.' : 'That cannot be used right now.'); return; }
    spendAbility(k);
    setUsedAb({ key: runKey, used: [...used, k] });
  };

  // Background music plays during a level when it is switched on in Settings (and sound is on).
  useEffect(() => {
    if (screen === 'game' && save.settings.music && save.settings.sound && !paused) startMusic(); else stopMusic();
    return stopMusic;
  }, [screen, save.settings.music, save.settings.sound, paused]);

  useEffect(() => { document.documentElement.classList.toggle('hc', save.settings.contrast); }, [save.settings.contrast]);

  const theme = THEMES[(level?.theme ?? 0) % THEMES.length];
  const setSettings = (s: GameSettings) => commit({ ...saveRef.current, settings: s });

  if (screen === 'settings') {
    return (
      <SettingsPanel
        save={save}
        onSettings={setSettings}
        canGyro={canTiltPhone}
        onGyro={(on) => void setGyro(on)}
        onReplace={commit}
        onReset={async () => commit(await resetSave())}
        onBack={() => setScreen('menu')}
      />
    );
  }

  if (screen === 'levels') {
    return <LevelSelect save={save} onPick={(n) => { sound.click(); start(n); }} onBack={() => setScreen('menu')} />;
  }

  return (
    <>
      {splash && (
        <div className="splash" aria-hidden>
          <i className="splash-ball" />
          <b>Control<br /><em>Your</em><br />Balls</b>
        </div>
      )}
      {award && <AwardToast ability={award.key} canUse={award.live && award.key !== 'extra' && screen === 'game' && snap?.status === 'playing' && !used.includes(award.key)} onUse={() => { fireAbility(award.key); setAward(null); }} onLater={() => setAward(null)} />}
      {notice && (
        <div className="notice" role="alert">
          {notice} <button className="link" onClick={() => setNotice('')}>Dismiss</button>
        </div>
      )}
      {screen === 'menu' && (
        <MainMenu
          ready={loaded}
          onSecret={() => { sound.click(); if (claimSecret()) { setAbTick((t) => t + 1); setNotice('Secret found: +1 of every power-up. Thanks for looking closely.'); } else setNotice('Already found. Every power-up has its charge.'); }}
          level={Math.min(save.currentLevel, save.highestUnlocked)}
          completed={save.stats.levelsCompleted}
          onTutorial={() => { sound.click(); start(1, undefined, false, true); }}
          onPlay={() => { sound.click(); start(Math.min(save.currentLevel, save.highestUnlocked)); }}
          onDaily={() => { sound.click(); playDaily(); }}
          daily={dailyInfo}
          onWeekly={() => { sound.click(); playWeekly(); }}
          onInstall={installEvt ? () => { void installEvt.prompt(); setInstallEvt(null); } : undefined}
          onRandom={() => { sound.click(); playRandom(); }}
          onLevels={() => setScreen('levels')}
          onSettings={() => setScreen('settings')}
        />
      )}
      {screen === 'game' && level && (
        <div className={`game${save.settings.leftHand ? ' lefty' : ''}`} style={{ background: `linear-gradient(180deg, ${theme.bgTop}, ${theme.bgBottom})` }}>
          <div className="canvas-wrap">
            <GameCanvas
              level={playLevel ?? level}
              attempt={attempt}
              paused={paused || tutorial || tips.length > 0}
              settings={save.settings}
              controllerRef={controller}
              onSnapshot={onSnapshot}
            />
          </div>
          {!snap && <GameLoading />}
          {tutorial && snap && <Tutorial onDone={finishTutorial} />}
          {!tutorial && snap && tips.length > 0 && <TipCard tips={tips} onDone={() => { markTipsSeen(tips.map((t) => t.key)); setTips([]); }} />}
          <GameHUD
            label={practice ? 'Practice' : daily ? 'Daily challenge' : weekly ? 'Weekly challenge' : random ? `Random · ${level.trays.length} trays` : `Level ${level.levelNumber}${level.tier === 'boss' ? ' · BOSS' : level.tier === 'hard' ? ' · HARD' : ''}`}
            tier={level.tier}
            classCount={level.classRadii.length}
            snap={snap}
            attempt={attempt}
            firstLevel={!random && level.levelNumber === 1 && save.stats.levelsCompleted === 0}
            sound={save.settings.sound}
            sensitivity={save.settings.sensitivity}
            onSensitivity={() => { const L = [0.6, 1, 1.5, 2]; const i = L.indexOf(save.settings.sensitivity); setSettings({ ...save.settings, sensitivity: L[(i + 1) % L.length] }); }}
            onSound={() => setSettings({ ...save.settings, sound: !save.settings.sound })}
            canTiltPhone={canTiltPhone}
            phoneTilt={phoneTilt}
            readTilt={() => controller.current?.getTilt() ?? [0, 0]}
            onHelp={() => { const t = level ? tipsOf(level) : []; if (t.length) setTips(t); }}
            onPause={() => setPaused(true)}
            onRestart={restart}
            onCamera={() => { controller.current?.resetCamera(); calibrate.current(); }}
            onOrbit={(a, e) => controller.current?.orbit(a, e)}
            onFlat={() => controller.current?.setPointer(0, 0)}
            stock={stock}
            usedAbilities={used}
            onAbility={fireAbility}
            onPhoneTilt={togglePhoneTilt}
          />
          {paused && snap?.status === 'playing' && <PauseOverlay sound={save.settings.sound} onSound={() => setSettings({ ...save.settings, sound: !save.settings.sound })} canGyro={canTiltPhone} gyro={phoneTilt} onGyro={togglePhoneTilt} onHelp={() => { setPaused(false); const t = level ? tipsOf(level) : []; if (t.length) setTips(t); }} practice={practice} onPractice={() => { setPractice((p) => !p); setPaused(false); restart(); }} onResume={() => setPaused(false)} onRestart={restart} onMenu={toMenu} />}
          {snap?.status === 'failed' && <FailedOverlay onSkip={!random && fails >= 20 ? skipLevel : undefined} collected={snap.collected} required={snap.required} lost={snap.lost} lostTrap={snap.lostTrap} lostVoid={snap.lostVoid} onRetry={restart} onMenu={toMenu} />}
          {snap?.status === 'won' && <CompletedOverlay levelNumber={level?.levelNumber} challenge={level ? { level: level.levelNumber, seed: level.seed } : undefined} best={random ? undefined : bestInfo ?? undefined} nextLabel={daily || weekly ? 'Back to menu' : undefined} streak={daily ? dayStreak : undefined} seconds={snap.elapsed} lost={snap.lost} allowedLoss={snap.allowedLoss} total={snap.total} random={random} onNext={nextLevel} onRetry={restart} onMenu={toMenu} />}
        </div>
      )}
    </>
  );
}
