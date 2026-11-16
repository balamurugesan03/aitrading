import { Link } from 'react-router-dom';
import { Power, Bot, ArrowRight } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { SEGMENTS, STATE_UI, segmentOf, segmentStatus, startOfToday } from '../lib/markets.js';
import { fmtMoney, tone } from '../lib/format.js';

// One tile per market: is live trading ON, how many bots run there, and today's realized P&L.
export default function TradingStatus({ bots, trades }) {
  const { status, access } = useApp();
  const exchanges = status?.exchanges;
  const today = startOfToday();

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title"><Power size={14} /> Trading Status · what is ON now</span>
        <Link to="/history" className="btn sm ghost">P&amp;L history <ArrowRight size={13} /></Link>
      </div>
      <div className="seg-status-grid">
        {SEGMENTS.map((seg) => {
          const st = segmentStatus(seg, { status, access });
          const ui = STATE_UI[st.state];
          const segBots = (bots || []).filter((b) => b.status === 'running' && segmentOf(exchanges, b.exchange)?.id === seg.id);
          const liveBots = segBots.filter((b) => b.mode === 'live').length;
          const todayPnl = (trades || [])
            .filter((t) => t.pnl !== undefined && t.time >= today && segmentOf(exchanges, t.exchange)?.id === seg.id)
            .reduce((s, t) => s + t.pnl, 0);
          return (
            <div key={seg.id} className={`seg-status ${ui.cls}`} title={st.reason}>
              <div className="row between" style={{ gap: 8 }}>
                <span className="bold">{seg.label}</span>
                <span className={`state-pill ${ui.cls}`}><i />{ui.label}</span>
              </div>
              <div className={`tiny ${st.warn ? 'down' : 'muted'}`}>{st.reason}</div>
              <div className="row between small" style={{ marginTop: 'auto' }}>
                <span className="row muted" style={{ gap: 5 }}>
                  <Bot size={13} />
                  {segBots.length ? <>{segBots.length} running{liveBots ? <b className="down">&nbsp;· {liveBots} live</b> : ''}</> : 'No bots'}
                </span>
                {trades && <span className={`mono ${tone(todayPnl)}`} title="Realized P&L today">{todayPnl ? fmtMoney(todayPnl, seg.currency) : '—'} <span className="tiny dim">today</span></span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Compact version for the sidebar footer: one line per market with a colored dot.
export function SidebarTradingStatus() {
  const { status, access } = useApp();
  return SEGMENTS.slice(0, 3).map((seg) => {
    const st = segmentStatus(seg, { status, access });
    const ui = STATE_UI[st.state];
    return (
      <div key={seg.id} className="row between" title={st.reason}>
        <span className="muted">{seg.short}</span>
        <span className={`state-pill sm ${ui.cls}`}><i />{ui.label}</span>
      </div>
    );
  });
}
