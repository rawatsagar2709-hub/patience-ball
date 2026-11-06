'use client';
import { useEffect, useState } from 'react';
import { readMissions } from '@/lib/missions';
import { ABILITIES, TASKS, readAbilities, type AbilityKey } from '@/lib/abilities';
import Icon from './Icons';
import MenuBoard from './MenuBoard';

interface Props {
  level: number;
  completed: number;
  onPlay: () => void;
  onRandom: () => void;
  onLevels: () => void;
  onSettings: () => void;
  onSecret: () => void;
  onTutorial: () => void;
  onDaily: () => void;
  daily: { done: boolean; streak: number; weeklyDone: boolean };
  onWeekly: () => void;
  onInstall?: () => void;
  ready: boolean;
}

export default function MainMenu({ level, completed, onPlay, onRandom, onLevels, onSettings, onSecret, onTutorial, onDaily, daily, onWeekly, onInstall, ready }: Props) {
  // Weekly/missions read localStorage, so they render only after hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { const t = setTimeout(() => setMounted(true), 0); return () => clearTimeout(t); }, []);
  return (
    <main className="menu" id="main">
      <h1 aria-label="Control Your Balls"><span>Control</span><em>Your</em><span>Balls</span></h1>
      <MenuBoard onWin={onPlay} ready={ready} />
      <p className="tagline" aria-label="Drag the board to tilt it. Roll the ball into the green hole.">{'Drag the board to tilt it. Roll the ball into the green hole.'.split(' ').map((w, i) => <span key={i} aria-hidden style={{ ['--i' as string]: i }}>{w} </span>)}</p>
      <div className="menu-actions">
        <button className="btn primary big" onClick={onPlay} disabled={!ready}>
          {completed > 0 ? `▶  Continue · Level ${level}` : '▶  Play'}
        </button>
        <div className="row2">
          <button className={`btn daily${daily.done ? ' done' : ''}`} onClick={onDaily} disabled={!ready}>
            {daily.done ? '✓ Daily' : <><Icon name="flame" size={18} /> Daily</>}{daily.streak > 0 && <small> {daily.streak}d</small>}
          </button>
          <button className="btn" onClick={onLevels} disabled={!ready}>Levels</button>
        </div>
        {onInstall && <button className="btn ghost" onClick={onInstall}><Icon name="install" size={18} /> Install app</button>}
      </div>
      <p className="where">World {Math.ceil(level / 10)} · level {((level - 1) % 10) + 1} of 10</p>
      <details className="more">
        <summary>More</summary>
        <nav className="tabs" aria-label="More modes">
          <button onClick={onWeekly} disabled={!ready}>{daily.weeklyDone ? '✓ Weekly' : 'Weekly'}</button>
          <button onClick={onRandom} disabled={!ready}>Random</button>
          <button onClick={onTutorial} disabled={!ready}>Tutorial</button>
        </nav>
        {mounted && <section className="weekly" aria-label="Weekly tasks">
          <h2>Weekly tasks: earn abilities</h2>
          <ul>
            {(() => { const a = readAbilities(); return TASKS.map((t, i) => (
              <li key={t.kind} className={a.prog[i] >= t.goal ? 'done' : ''}>
                <i style={{ width: `${(a.prog[i] / t.goal) * 100}%` }} />
                <span>{a.prog[i] >= t.goal ? '✓ ' : ''}{t.label}</span><b>{a.prog[i]}/{t.goal}</b>
                <small>Reward: {ABILITIES[t.reward].name}</small>
              </li>
            )); })()}
          </ul>
          <p className="have">{(Object.keys(ABILITIES) as AbilityKey[]).map((k) => `${ABILITIES[k].name} ×${readAbilities().stock[k]}`).join('  ·  ')}</p>
        </section>}
        {mounted && <section className="missions" aria-label="Daily missions">
          <h2>Today&apos;s missions</h2>
          <ul>
            {readMissions().map((m) => (
              <li key={m.kind} className={m.have >= m.goal ? 'done' : ''}>
                <i style={{ width: `${(m.have / m.goal) * 100}%` }} />
                <span>{m.have >= m.goal ? '✓ ' : ''}{m.label}</span><b>{m.have}/{m.goal}</b>
              </li>
            ))}
          </ul>
        </section>}
      <details className="guide">
        <summary>How to play &amp; obstacle guide</summary>
        <ol>
          <li><b>1</b>Drag the board to tilt it; it stays tilted. Drag the strip at the bottom to turn the view</li>
          <li><b>2</b>Roll balls out the open edge, tray by tray</li>
          <li><b>3</b>Each ball size fits only its own green hole. Red holes swallow balls</li>
        </ol>
        <ul className="legend">
          <li><i style={{ background: '#ff6fd0' }} />Bumpers kick</li>
          <li><i style={{ background: '#ffd23f' }} />Pads boost</li>
          <li><i style={{ background: '#7a5230' }} />Mud slows</li>
          <li><i style={{ background: '#31e0ff' }} />Blades spin</li>
          <li><i style={{ background: '#e0b020' }} />Gates rise and sink</li>
          <li><i style={{ background: '#ff9a1f' }} />Doors open for a few seconds</li>
          <li><i style={{ background: '#9b5cff' }} />Purple discs pull, orange push</li>
          <li><i style={{ background: '#3fd6c0' }} />Teal arrows: conveyor floor</li>
          <li><i style={{ background: '#9fe8ff' }} />Glass walls pass small or big balls</li>
          <li><i style={{ background: '#ff4d5e' }} />Red-edged sides have no wall</li>
          <li><i style={{ background: '#e6f8ff' }} />Ice slides, ridges grip, pink bounces</li>
          <li><i style={{ background: '#c86bff' }} />Portals teleport</li>
        </ul>
      </details>
      </details>
      <button type="button" className="credit" onClick={onSecret} aria-label="Made by Sagar S Rawat">
        <small aria-hidden>made by</small>
        <span aria-hidden>{'Sagar S Rawat'.split('').map((c, i) => <i key={i} style={{ ['--k' as string]: i }}>{c === ' ' ? '\u00a0' : c}</i>)}</span>
      </button>
      <button className="gear" onClick={onSettings} aria-label="Settings"><Icon name="gear" size={22} /></button>
    </main>
  );
}
