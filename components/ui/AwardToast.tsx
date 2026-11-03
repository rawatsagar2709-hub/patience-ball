'use client';
import { useEffect } from 'react';
import { ABILITIES, type AbilityKey } from '@/lib/abilities';
import Icon from './Icons';

/** Shown when a weekly task pays out. `canUse` is false when the ability cannot be fired right now. */
export default function AwardToast({ ability, canUse, onUse, onLater }: { ability: AbilityKey; canUse: boolean; onUse: () => void; onLater: () => void }) {
  useEffect(() => { const t = setTimeout(onLater, 12000); return () => clearTimeout(t); }, [onLater]);
  const a = ABILITIES[ability];
  return (
    <div className="award" role="status">
      <span className="award-ico" aria-hidden><Icon name={ability} size={26} /></span>
      <div className="award-txt">
        <small>Weekly task done</small>
        <strong>{a.name}</strong>
        <span>{canUse ? a.text : `${ability === 'extra' ? 'Ready from your next level.' : 'Saved to your stock.'}`}</span>
      </div>
      <div className="award-btns">
        {canUse && <button className="btn primary" onClick={onUse}>Use now</button>}
        <button className="btn" onClick={onLater}>{canUse ? 'Later' : 'Got it'}</button>
      </div>
    </div>
  );
}
