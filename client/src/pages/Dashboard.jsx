import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallet, TrendingUp, Bot, Trophy, Gauge, Flame, Activity, Zap } from 'lucide-react';
import { usePoll, useServerEvents } from '../lib/hooks.js';
import { useApp } from '../lib/AppContext.jsx';
import { CoinIcon, ActionBadge, FearGreed, Empty } from '../components/ui.jsx';
import { fmtUsd, fmtMoney, fmtPct, fmtPrice, fmtCompact, fmtQty, ago, tone, baseOf, quoteOf } from '../lib/format.js';

export default function Dashboard() {
  const { mode, setSymbol, exchange, money, market } = useApp();
  const nav = useNavigate();
  const [portfolio, pErr] = usePoll(`/portfolio?mode=${mode}&exchange=${exchange}`, 15000, [mode, exchange]);
  const [bots, , reloadBots] = usePoll('/bots', 15000);
  const [top] = usePoll(`/market/top?limit=12&exchange=${exchange}`, 20000, [exchange]);
  const [fng] = usePoll(market === 'crypto' ? '/market/sentiment' : null, 600000, [market]);
  const [trades, , reloadTrades] = usePoll(`/trades?mode=${mode}&limit=8`, 0, [mode]);
  const [feed, setFeed] = useState([]);

  useServerEvents((type, p) => {
    if (type === 'log') setFeed((f) => [p, ...f].slice(0, 40));
    if (type === 'trade') { reloadTrades(); reloadBots(); }
  });

  const running = bots?.filter((b) => b.status === 'running') || [];
  const pnlVsStart = portfolio?.startBalance ? portfolio.total - portfolio.startBalance : null;
  const open = (s) => { setSymbol(s); nav('/terminal'); };

  return (
    <>
      <div className="grid g-4">
        <div className="card stat">
          <span className="stat-icon"><Wallet size={18} /></span>
          <span className="stat-label">Portfolio Value · {mode}</span>
          <span className="stat-value">{portfolio ? money(portfolio.total) : pErr ? '—' : '…'}</span>
          {pnlVsStart !== null && portfolio && (
            <span className={`stat-sub mono ${tone(pnlVsStart)}`}>{money(pnlVsStart)} ({fmtPct((pnlVsStart / portfolio.startBalance) * 100)}) all-time</span>
          )}
          {pErr && <span className="stat-sub down">{pErr}</span>}
        </div>
        <div className="card stat">
          <span className="stat-icon green"><TrendingUp size={18} /></span>
          <span className="stat-label">Realized PnL</span>
          <span className={`stat-value ${tone(portfolio?.realizedPnl)}`}>{portfolio ? money(portfolio.realizedPnl) : '…'}</span>
          <span className="stat-sub muted">{portfolio?.closedTrades || 0} closed trades</span>
        </div>
        <div className="card stat">
          <span className="stat-icon violet"><Trophy size={18} /></span>
          <span className="stat-label">Win Rate</span>
          <span className="stat-value">{portfolio ? `${portfolio.winRate.toFixed(1)}%` : '…'}</span>
          <div className="meter" style={{ marginTop: 4 }}><i style={{ left: 0, width: `${portfolio?.winRate || 0}%`, background: 'linear-gradient(90deg,var(--accent-2),var(--accent))' }} /></div>
        </div>
        <div className="card stat">
          <span className="stat-icon warn"><Bot size={18} /></span>
          <span className="stat-label">Active AI Bots</span>
          <span className="stat-value">{running.length}<span className="muted" style={{ fontSize: 16 }}> / {bots?.length || 0}</span></span>
          <span className="stat-sub muted">{running.map((b) => baseOf(b.symbol)).join(' · ') || 'No bots running'}</span>
        </div>
      </div>

      <div className="grid g-wide">
        <div className="card">
          <div className="card-head">
            <span className="card-title"><Flame size={14} /> Top Markets by Volume</span>
            <span className="tiny dim">{exchange} spot · 24h</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Asset</th><th className="num">Price</th><th className="num">24h</th><th className="num">High</th><th className="num">Low</th><th className="num">Volume</th></tr></thead>
              <tbody>
                {(top || []).map((t) => (
                  <tr key={t.symbol} className="clickable" onClick={() => open(t.symbol)}>
                    <td><div className="coin"><CoinIcon symbol={t.symbol} />{baseOf(t.symbol)}<span className="dim small">/{quoteOf(t.symbol)}</span></div></td>
                    <td className="num">{fmtPrice(t.price)}</td>
                    <td className={`num ${tone(t.change)}`}>{fmtPct(t.change)}</td>
                    <td className="num muted">{fmtPrice(t.high)}</td>
                    <td className="num muted">{fmtPrice(t.low)}</td>
                    <td className="num muted">${fmtCompact(t.volume)}</td>
                  </tr>
                ))}
                {!top && [...Array(6)].map((_, i) => <tr key={i}><td colSpan={6}><div className="skeleton" style={{ height: 22 }} /></td></tr>)}
              </tbody>
            </table>
          </div>
        </div>

        <div className="col" style={{ gap: 18 }}>
          {market === 'crypto' && (
            <div className="card">
              <div className="card-head"><span className="card-title"><Gauge size={14} /> Fear &amp; Greed Index</span></div>
              <FearGreed data={fng} />
              <div className="tiny dim" style={{ textAlign: 'center', marginTop: 6 }}>The AI uses this as a contrarian sentiment input</div>
            </div>
          )}
          <div className="card">
            <div className="card-head"><span className="card-title"><Wallet size={14} /> Holdings</span></div>
            <div className="col" style={{ gap: 10 }}>
              {(portfolio?.assets || []).slice(0, 6).map((a) => (
                <div key={a.asset} className="row between">
                  <div className="coin"><CoinIcon symbol={market === 'crypto' ? `${a.asset}USDT` : a.asset} size={24} />{a.asset}</div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="mono">{money(a.value)}</div>
                    <div className="tiny dim mono">{fmtQty(a.amount)}</div>
                  </div>
                </div>
              ))}
              {portfolio && !portfolio.assets.length && <Empty title="Empty wallet" />}
            </div>
          </div>
        </div>
      </div>

      <div className="grid g-2">
        <div className="card">
          <div className="card-head"><span className="card-title"><Activity size={14} /> Recent Trades</span></div>
          {trades?.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Pair</th><th>Side</th><th className="num">Price</th><th className="num">Value</th><th className="num">PnL</th><th>When</th></tr></thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t._id}>
                      <td><div className="coin"><CoinIcon symbol={t.symbol} size={22} />{baseOf(t.symbol)}</div></td>
                      <td><ActionBadge action={t.side === 'BUY' ? 'BUY' : 'SELL'} /></td>
                      <td className="num">{fmtPrice(t.price)}</td>
                      <td className="num">{fmtMoney(t.cost, quoteOf(t.symbol))}</td>
                      <td className={`num ${tone(t.pnl)}`}>{t.pnl !== undefined ? fmtMoney(t.pnl, quoteOf(t.symbol)) : '—'}</td>
                      <td className="dim small">{ago(t.time)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty icon={Activity} title="No trades yet">Start an AI bot or place an order from the terminal.</Empty>}
        </div>
        <div className="card">
          <div className="card-head">
            <span className="card-title"><Zap size={14} /> Live AI Activity</span>
            <span className="row tiny muted" style={{ gap: 6 }}><span className="dot live" /> streaming</span>
          </div>
          {feed.length ? (
            <div className="log-feed">
              {feed.map((l) => (
                <div key={l._id} className="log-line">
                  <span className="dim">{new Date(l.time).toLocaleTimeString()}</span>
                  <span className={`lvl ${l.level}`}>{l.level}</span>
                  <span>{bots?.find((b) => b._id === l.botId)?.name ? <b>{bots.find((b) => b._id === l.botId).name}: </b> : null}{l.msg}</span>
                </div>
              ))}
            </div>
          ) : <Empty icon={Zap} title="Waiting for bot activity">Signals and trades from running bots appear here in real time.</Empty>}
        </div>
      </div>
    </>
  );
}
