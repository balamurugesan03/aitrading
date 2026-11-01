import { useState } from 'react';
import { Activity, Landmark, Newspaper, CalendarClock } from 'lucide-react';
import { usePoll } from '../lib/hooks.js';
import { useApp } from '../lib/AppContext.jsx';
import { OrderFlowPanel, FuturesPanel, NewsPanel } from '../components/IntelPanels.jsx';
import { CoinIcon, Seg } from '../components/ui.jsx';
import { baseOf } from '../lib/format.js';

const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];

function Calendar() {
  const [c] = usePoll('/market/calendar', 600000);
  if (!c) return null;
  const upcoming = c.events.filter((e) => e.time > Date.now() - 3600e3).slice(0, 12);
  return (
    <div className="card">
      <div className="card-head"><span className="card-title"><CalendarClock size={14} /> Economic Calendar</span><span className={`badge ${c.risk.multiplier < 1 ? 'warn' : 'flat'}`}>Risk engine: size × {c.risk.multiplier}</span></div>
      <div className="small muted" style={{ marginBottom: 10 }}>{c.risk.note}. Position size is cut around high-impact USD releases (CPI, FOMC, NFP).</div>
      {upcoming.length ? (
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Event</th><th>Country</th><th>Impact</th><th className="num">Forecast</th><th className="num">Previous</th></tr></thead>
          <tbody>{upcoming.map((e) => (
            <tr key={e.title + e.time}><td className="small muted">{new Date(e.time).toLocaleString('en-IN', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</td><td className={e.cryptoMover ? 'bold' : ''}>{e.title}</td><td>{e.country}</td><td><span className={`badge ${e.impact === 'High' ? 'down' : 'warn'}`}>{e.impact}</span></td><td className="num">{e.forecast || '—'}</td><td className="num muted">{e.previous || '—'}</td></tr>
          ))}</tbody></table></div>
      ) : <div className="small dim">No remaining high/medium-impact events this week.</div>}
    </div>
  );
}

export default function Intel() {
  const { symbol, setSymbol, exchange } = useApp();
  const [newsScope, setNewsScope] = useState('market');
  return (
    <>
      <div className="card">
        <div className="row wrap between" style={{ gap: 12 }}>
          <div>
            <div className="bold" style={{ fontSize: 16 }}>Market Intelligence</div>
            <div className="small muted">Live order flow, futures positioning and news — the inputs the AI adds on top of price action.</div>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {[...new Set([symbol, ...COINS])].map((s) => (
              <button key={s} className={`chip-toggle ${s === symbol ? 'on' : ''}`} onClick={() => setSymbol(s)}>
                <span className="row" style={{ gap: 6 }}><CoinIcon symbol={s} size={16} />{baseOf(s)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid g-3">
        <div className="card">
          <div className="card-head"><span className="card-title"><Activity size={14} /> Order Flow AI · {baseOf(symbol)}</span></div>
          <OrderFlowPanel symbol={symbol} exchange={exchange} />
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title"><Landmark size={14} /> Futures Intelligence · {baseOf(symbol)}</span></div>
          <FuturesPanel symbol={symbol} />
        </div>
        <div className="card">
          <div className="card-head">
            <span className="card-title"><Newspaper size={14} /> News AI</span>
            <Seg value={newsScope} onChange={setNewsScope} options={[{ value: 'market', label: 'All' }, { value: 'coin', label: baseOf(symbol) }]} />
          </div>
          <NewsPanel asset={newsScope === 'coin' ? baseOf(symbol) : null} limit={25} />
        </div>
      </div>
      <Calendar />
    </>
  );
}
