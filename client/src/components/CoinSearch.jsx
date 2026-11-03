import { useState } from 'react';
import { usePoll } from '../lib/hooks.js';

// Search box over every USDT pair the exchange lists, so any coin can be picked (not just the shortcut chips).
export default function CoinSearch({ onPick, exchange = 'binance', placeholder = 'Add any coin (e.g. PEPE)' }) {
  const [q, setQ] = useState('');
  const [all] = usePoll(`/market/symbols?quote=USDT&exchange=${exchange}`, 0, [exchange]);
  const id = `coins-${exchange}`;
  const pick = (v) => {
    let s = String(v || '').trim().toUpperCase();
    if (!s) return;
    if (!s.endsWith('USDT')) s += 'USDT';
    if (all && !all.includes(s)) return;
    onPick(s);
    setQ('');
  };
  return (
    <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); pick(q); }}>
      <input className="input mono" list={id} value={q} placeholder={all ? `${placeholder} · ${all.length} coins` : placeholder}
        onChange={(e) => { const v = e.target.value; setQ(v); if (all?.includes(v.toUpperCase())) pick(v); }} style={{ minWidth: 200 }} />
      <datalist id={id}>{(all || []).map((s) => <option key={s} value={s} />)}</datalist>
      <button className="btn" type="submit">Add</button>
    </form>
  );
}
