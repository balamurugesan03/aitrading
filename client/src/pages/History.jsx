import { Fragment, useMemo, useState } from 'react';
import {
  History as HistoryIcon, Download, TrendingUp, TrendingDown, Minus, Trophy, Receipt, BarChart3, ArrowRight,
  HelpCircle, ChevronDown, ChevronRight, CheckCircle2, XCircle, Lightbulb, Wallet, Lock,
} from 'lucide-react';
import { usePoll } from '../lib/hooks.js';
import { useApp } from '../lib/AppContext.jsx';
import { CoinIcon, Seg, Empty } from '../components/ui.jsx';
import { fmtPrice, fmtMoney, fmtPct, fmtQty, tone, baseOf } from '../lib/format.js';
import { SEGMENTS, segmentOf, currencyOf, dayKey, startOfToday } from '../lib/markets.js';

const DAY = 86400e3;
const PERIODS = [
  { value: 'today', label: 'Today', days: 1 },
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: '90d', label: '90 days', days: 90 },
  { value: 'all', label: 'All', days: null },
  { value: 'custom', label: 'Custom' },
];
const PAGE = 150;
const CUR_LABEL = { USDT: 'Crypto account · USDT', INR: 'NSE account · INR (₹)' };

// <input type="datetime-local"> value for a timestamp (local time).
const toLocalInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fmtWhen = (t) => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeOf = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const fmtDur = (ms) => {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};
const dayLabel = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const diff = Math.round((startOfToday() - date.getTime()) / DAY);
  const txt = date.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  return diff === 0 ? `Today · ${txt}` : diff === 1 ? `Yesterday · ${txt}` : txt;
};
const shortDay = (key) => dayLabel(key).replace(/ · .*$/, '');

// Money that went into a closed trade (its entry cost). pnlPct is stored as pnl / entry cost, so cost = pnl / pnlPct.
const investedIn = (t) => (t.pnlPct ? Math.abs(t.pnl / (t.pnlPct / 100)) : Math.abs(t.cost - t.pnl));

// Why a trade closed, in plain words.
const REASONS = [
  { re: /grid take-profit/i, label: 'Grid take-profit', why: 'Price bounced up to the next grid level and the bot sold that slice.' },
  { re: /dca take-profit/i, label: 'DCA take-profit', why: 'The averaged-down position recovered to its profit target.' },
  { re: /take-profit/i, label: 'Take-profit hit', why: 'Price reached the target the AI set at entry - the plan worked.' },
  { re: /stop-loss/i, label: 'Stop-loss hit', why: 'Price moved against the trade and hit the stop - the loss was capped as planned.' },
  { re: /^AI exit/i, label: 'AI exit signal', why: 'The AI saw the trend weaken or turn and closed before the stop or target.' },
  { re: /^Liquidated/i, label: 'Liquidated', why: 'Leverage was too high for the move - the margin ran out and the exchange closed it.' },
  { re: /^Kill switch/i, label: 'Kill switch', why: 'You pressed the kill switch (or a safety rule did) and everything was closed.' },
  { re: /^Manual/i, label: 'Manual close', why: 'You closed it yourself.' },
  { re: /expiry/i, label: 'Contract expiry', why: 'The futures contract was about to expire, so the position was closed.' },
  { re: /no longer on the exchange/i, label: 'Closed outside the bot', why: 'The coins were sold or moved outside the bot.' },
];
const reasonOf = (r = '') => REASONS.find((x) => x.re.test(r)) || { label: (r.split('(')[0].trim() || 'Other').slice(0, 40), why: r || 'No reason recorded.' };

function summarize(trades) {
  const closed = trades.filter((t) => t.pnl !== undefined);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const sum = (a) => a.reduce((s, t) => s + t.pnl, 0);
  const invested = closed.reduce((s, t) => s + investedIn(t), 0);
  const net = sum(closed);
  return {
    closed: closed.length, wins: wins.length, losses: losses.length,
    profit: sum(wins), loss: sum(losses), net, invested, back: invested + net,
    returnPct: invested ? (net / invested) * 100 : null,
    fees: trades.reduce((s, t) => s + (t.fee || 0), 0),
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    best: closed.reduce((b, t) => (!b || t.pnl > b.pnl ? t : b), null),
    worst: closed.reduce((w, t) => (!w || t.pnl < w.pnl ? t : w), null),
  };
}

// Daily realized P&L as bars from a zero baseline: green above (profit day), red below (loss day). Hover a day for details.
function DailyBars({ days, currency }) {
  const [hover, setHover] = useState(null);
  const maxUp = Math.max(0, ...days.map((d) => d.pnl));
  const maxDown = Math.max(0, ...days.map((d) => -d.pnl));
  const span = maxUp + maxDown || 1;
  const upShare = maxDown === 0 ? 1 : maxUp === 0 ? 0 : maxUp / span;
  const h = hover !== null ? days[hover] : null;
  return (
    <div className="pnl-bars-wrap">
      <div className="pnl-bars-tip small">
        {h ? (
          <><span className="muted">{dayLabel(h.key)}</span> · <b className={`mono ${tone(h.pnl)}`}>{fmtMoney(h.pnl, currency)}</b> <span className="dim">· {h.count} closed trade{h.count === 1 ? '' : 's'}</span></>
        ) : <span className="dim">Hover a bar to see that day</span>}
      </div>
      <div className="pnl-bars" role="img" aria-label="Daily realized profit and loss">
        <div className="pnl-zero" style={{ top: `${upShare * 100}%` }} />
        {days.map((d, i) => (
          <div key={d.key} className={`pnl-col ${hover === i ? 'on' : ''}`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            {d.pnl !== 0 && (
              <i className={d.pnl > 0 ? 'up' : 'down'} style={d.pnl > 0
                ? { bottom: `${(1 - upShare) * 100}%`, height: `max(2px, ${(d.pnl / span) * 100}%)` }
                : { top: `${upShare * 100}%`, height: `max(2px, ${(-d.pnl / span) * 100}%)` }} />
            )}
          </div>
        ))}
      </div>
      <div className="row between tiny dim"><span>{shortDay(days[0].key)}</span><span>{shortDay(days[days.length - 1].key)}</span></div>
    </div>
  );
}

// "Why": closed trades grouped by exit reason (and by coin), split into where the profit came from and where the loss came from.
function WhyBreakdown({ closed, currency }) {
  const money = (v) => fmtMoney(v, currency);
  const group = (list, keyOf) => {
    const m = new Map();
    for (const t of list) {
      const k = keyOf(t);
      const g = m.get(k) || { key: k, n: 0, sum: 0 };
      g.n += 1;
      g.sum += t.pnl;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum));
  };
  const side = (list, kind) => {
    const byReason = group(list, (t) => reasonOf(t.reason).label);
    const byCoin = group(list, (t) => baseOf(t.symbol)).slice(0, 5);
    const total = Math.abs(list.reduce((s, t) => s + t.pnl, 0)) || 1;
    return (
      <div className={`why-side ${kind}`}>
        <div className="bold" style={{ marginBottom: 10 }}>{kind === 'up' ? <span className="up">Why you made profit</span> : <span className="down">Why you lost money</span>}</div>
        {byReason.length ? byReason.map((g) => (
          <div key={g.key} className="why-row">
            <div className="row between small"><span className="bold">{g.key} <span className="dim">· {g.n} trade{g.n === 1 ? '' : 's'}</span></span><b className={`mono ${kind}`}>{money(g.sum)}</b></div>
            <div className="why-bar"><i className={kind} style={{ width: `${(Math.abs(g.sum) / total) * 100}%` }} /></div>
            <div className="tiny muted">{REASONS.find((r) => r.label === g.key)?.why || ''}</div>
          </div>
        )) : <div className="small dim">{kind === 'up' ? 'No winning trades in this period.' : 'No losing trades in this period.'}</div>}
        {byCoin.length > 0 && (
          <div className="tiny muted" style={{ marginTop: 10 }}>
            By coin: {byCoin.map((g, i) => <span key={g.key}>{i ? ' · ' : ''}<b style={{ color: 'var(--text-2)' }}>{g.key}</b> <span className={`mono ${kind}`}>{money(g.sum)}</span></span>)}
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="why-grid">
      {side(closed.filter((t) => t.pnl > 0), 'up')}
      {side(closed.filter((t) => t.pnl < 0), 'down')}
    </div>
  );
}

function CurrencySummary({ currency, trades, range, openCost }) {
  const s = summarize(trades);
  const money = (v) => fmtMoney(v, currency);
  const Icon = s.net > 0 ? TrendingUp : s.net < 0 ? TrendingDown : Minus;
  const verdict = !s.closed ? 'No closed trades yet' : s.net > 0 ? 'You are in PROFIT' : s.net < 0 ? 'You are in LOSS' : 'Break-even';
  const closed = trades.filter((t) => t.pnl !== undefined);

  // One bar per calendar day of the range (the last 90 at most); days without closed trades stay empty.
  const firstClosed = closed.length ? Math.min(...closed.map((t) => t.time)) : Date.now();
  const end = new Date(Math.min(range.to, Date.now())); end.setHours(0, 0, 0, 0);
  const startT = Math.max(range.from, firstClosed);
  const nDays = Math.max(1, Math.min(90, Math.round((end.getTime() - new Date(startT).setHours(0, 0, 0, 0)) / DAY) + 1));
  const byDay = {};
  for (const t of closed) {
    const k = dayKey(t.time);
    byDay[k] = byDay[k] || { pnl: 0, count: 0 };
    byDay[k].pnl += t.pnl;
    byDay[k].count += 1;
  }
  const days = [...Array(nDays)].map((_, i) => {
    const d = new Date(end);
    d.setDate(d.getDate() - (nDays - 1 - i));
    const key = dayKey(d.getTime());
    return { key, pnl: byDay[key]?.pnl || 0, count: byDay[key]?.count || 0 };
  });
  const greenDays = days.filter((d) => d.pnl > 0).length;
  const redDays = days.filter((d) => d.pnl < 0).length;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title"><BarChart3 size={14} /> {CUR_LABEL[currency] || currency}</span>
        <span className="tiny dim">{range.label}</span>
      </div>

      {/* Invested -> got back -> profit/loss */}
      <div className="money-flow">
        <div className="flow-box">
          <span className="tiny muted row" style={{ gap: 5 }}><Wallet size={13} /> You invested</span>
          <b className="mono">{money(s.invested)}</b>
          <span className="tiny dim">in {s.closed} closed trade{s.closed === 1 ? '' : 's'}</span>
        </div>
        <ArrowRight className="flow-arrow" size={22} />
        <div className="flow-box">
          <span className="tiny muted">You got back</span>
          <b className="mono">{money(s.back)}</b>
          <span className="tiny dim">after fees</span>
        </div>
        <ArrowRight className="flow-arrow" size={22} />
        <div className={`flow-box result ${tone(s.net)}`}>
          <span className="row" style={{ gap: 6 }}><Icon size={16} /><b className="tiny">{verdict}</b></span>
          <b className="mono flow-big">{s.net > 0 ? '+' : ''}{money(s.net)}</b>
          <span className="small mono">{s.returnPct === null ? '' : `${fmtPct(s.returnPct)} return`}</span>
        </div>
      </div>

      <div className="pnl-tiles" style={{ marginTop: 12 }}>
        <div className="pnl-tile up">
          <span className="tiny muted">Profit (winning trades)</span>
          <b className="mono up">+{money(s.profit)}</b>
          <span className="tiny dim">{s.wins} win{s.wins === 1 ? '' : 's'}</span>
        </div>
        <div className="pnl-tile down">
          <span className="tiny muted">Loss (losing trades)</span>
          <b className="mono down">{money(s.loss)}</b>
          <span className="tiny dim">{s.losses} loss{s.losses === 1 ? '' : 'es'}</span>
        </div>
        <div className="pnl-tile">
          <span className="tiny muted row" style={{ gap: 5 }}><Trophy size={13} /> Win rate</span>
          <b className="mono">{s.winRate === null ? '—' : `${s.winRate.toFixed(1)}%`}</b>
          <div className="winbar"><i style={{ width: `${s.winRate ?? 0}%` }} /></div>
        </div>
        <div className="pnl-tile">
          <span className="tiny muted row" style={{ gap: 5 }}><Lock size={13} /> In open trades now</span>
          <b className="mono">{openCost ? money(openCost) : '—'}</b>
          <span className="tiny dim">not counted until closed</span>
        </div>
        <div className="pnl-tile">
          <span className="tiny muted row" style={{ gap: 5 }}><Receipt size={13} /> Fees paid</span>
          <b className="mono">{money(s.fees)}</b>
          <span className="tiny dim">already inside P&amp;L</span>
        </div>
        <div className="pnl-tile">
          <span className="tiny muted">Best / worst trade</span>
          <b className="mono"><span className="up">{s.best && s.best.pnl > 0 ? money(s.best.pnl) : '—'}</span> <span className="dim">/</span> <span className="down">{s.worst && s.worst.pnl < 0 ? money(s.worst.pnl) : '—'}</span></b>
          <span className="tiny dim">{[s.best?.pnl > 0 && baseOf(s.best.symbol), s.worst?.pnl < 0 && baseOf(s.worst.symbol)].filter(Boolean).join(' / ')}</span>
        </div>
      </div>

      {closed.length > 0 && (
        <>
          {nDays > 1 && (
            <>
              <div className="row between small" style={{ marginTop: 18 }}>
                <span className="bold">Day by day</span>
                <span className="tiny"><span className="up">{greenDays} profit day{greenDays === 1 ? '' : 's'}</span> · <span className="down">{redDays} loss day{redDays === 1 ? '' : 's'}</span></span>
              </div>
              <DailyBars days={days} currency={currency} />
            </>
          )}
          <div className="divider" style={{ margin: '18px 0 14px' }} />
          <WhyBreakdown closed={closed} currency={currency} />
        </>
      )}
    </div>
  );
}

function ResultPill({ t, currency }) {
  if (t.pnl === undefined) return <span className="result-pill entry">OPENED</span>;
  const cls = t.pnl > 0 ? 'profit' : t.pnl < 0 ? 'loss' : 'flat';
  return (
    <span className={`result-pill ${cls}`}>
      {t.pnl > 0 ? '▲ PROFIT' : t.pnl < 0 ? '▼ LOSS' : '• EVEN'} <b className="mono">{t.pnl > 0 ? '+' : ''}{fmtMoney(t.pnl, currency)}</b>
      {Number.isFinite(t.pnlPct) && <span className="mono">({fmtPct(t.pnlPct)})</span>}
    </span>
  );
}

// Expanded row: when it was opened, how much went in, why it closed, and the AI journal's review.
function TradeStory({ t, entry, journal }) {
  const money = (v) => fmtMoney(v, t.currency);
  const r = reasonOf(t.reason);
  const sig = entry?.signal || t.signal;
  return (
    <div className="trade-story">
      <div className="story-steps">
        <div>
          <span className="tiny muted">1 · Opened</span>
          {entry ? <b>{fmtWhen(entry.time)}</b> : <b className="dim">entry not in this list</b>}
          <span className="small">{entry ? `${entry.side} at ${fmtPrice(entry.price)}` : ''}</span>
          <span className="small">Invested <b className="mono">{money(investedIn(t))}</b></span>
          {entry?.reason && <span className="tiny dim">{entry.reason}</span>}
        </div>
        <div>
          <span className="tiny muted">2 · Closed</span>
          <b>{fmtWhen(t.time)}</b>
          <span className="small">{t.side} at {fmtPrice(t.price)}{entry ? ` · held ${fmtDur(t.time - entry.time)}` : ''}</span>
          {entry && entry.price > 0 && <span className={`small mono ${tone(t.pnl)}`}>Price moved {fmtPct(((t.price - entry.price) / entry.price) * 100)}</span>}
        </div>
        <div>
          <span className="tiny muted">3 · Result</span>
          <b className={`mono ${tone(t.pnl)}`} style={{ fontSize: 18 }}>{t.pnl > 0 ? '+' : ''}{money(t.pnl)}</b>
          <span className="small">Got back {money(investedIn(t) + t.pnl)} (fees {money(t.fee || 0)})</span>
        </div>
      </div>
      <div className="story-why">
        <div className="row" style={{ gap: 8 }}><HelpCircle size={15} /><b>Why: {r.label}</b></div>
        <div className="small muted">{r.why}</div>
        {t.reason && t.reason !== r.label && <div className="tiny dim">Bot note: {t.reason}</div>}
        {sig && (
          <div className="tiny muted">
            Entry signal: {[sig.strategy && `strategy ${sig.strategy}`, sig.regime && `market ${sig.regime}`, sig.probability != null && `AI confidence ${(sig.probability * 100).toFixed(0)}%`, sig.quality && `grade ${sig.quality}`].filter(Boolean).join(' · ')}
          </div>
        )}
        {journal && (
          <>
            <div className="story-checks">
              {journal.checks?.map((c) => (
                <span key={c.key} className={`small ${c.ok ? 'up' : 'down'}`}>{c.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {c.text}</span>
              ))}
            </div>
            {journal.recommendation && <div className="small row" style={{ gap: 6, alignItems: 'flex-start' }}><Lightbulb size={14} className="up" style={{ flexShrink: 0, marginTop: 2 }} /> <span><b>Next time:</b> {journal.recommendation}</span></div>}
            {journal.aiReview && <div className="small muted" style={{ fontStyle: 'italic' }}>AI coach: {journal.aiReview}</div>}
          </>
        )}
      </div>
    </div>
  );
}

export default function HistoryPage() {
  const { status } = useApp();
  const exchanges = status?.exchanges;
  const [mode, setMode] = useState('all');
  const [period, setPeriod] = useState('30d');
  const [fromStr, setFromStr] = useState(() => toLocalInput(startOfToday() - 6 * DAY));
  const [toStr, setToStr] = useState(() => toLocalInput(Date.now()));
  const [market, setMarket] = useState('all');
  const [result, setResult] = useState('all');
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState(null);
  const [trades] = usePoll(`/trades?limit=100000${mode !== 'all' ? `&mode=${mode}` : ''}`, 15000, [mode]);
  const [bots] = usePoll('/bots', 30000);
  const [journal] = usePoll('/journal?limit=500', 60000);
  const [insights] = usePoll('/journal/insights', 300000);
  const resetPage = () => { setShown(PAGE); setOpen(null); };

  // Selected time range.
  const range = useMemo(() => {
    if (period === 'custom') {
      const from = new Date(fromStr).getTime() || 0;
      const to = new Date(toStr).getTime() || Date.now();
      return { from, to, label: `${fmtWhen(from)} → ${fmtWhen(to)}` };
    }
    const p = PERIODS.find((x) => x.value === period);
    return { from: p.days ? startOfToday() - (p.days - 1) * DAY : 0, to: Infinity, label: p.days ? (p.days === 1 ? 'Today' : `Last ${p.days} days`) : 'All time' };
  }, [period, fromStr, toStr]);

  // Each trade with its market segment and account currency (USDT crypto vs INR NSE never get added together).
  const rows = useMemo(() => (trades || []).map((t) => ({ ...t, seg: segmentOf(exchanges, t.exchange), currency: currencyOf(exchanges, t.exchange) })), [trades, exchanges]);

  const filtered = useMemo(() => rows.filter((t) => t.time >= range.from && t.time <= range.to
    && (market === 'all' || t.seg?.id === market)
    && (result === 'all' || (result === 'profit' ? t.pnl > 0 : result === 'loss' ? t.pnl < 0 : t.pnl === undefined))), [rows, range, market, result]);

  // Money sitting in bot positions that are still open (per currency, matching the account/market filters).
  const openCost = {};
  for (const b of bots || []) {
    if (!b.position?.cost || (mode !== 'all' && b.mode !== mode)) continue;
    const seg = segmentOf(exchanges, b.exchange);
    if (market !== 'all' && seg?.id !== market) continue;
    const c = currencyOf(exchanges, b.exchange);
    openCost[c] = (openCost[c] || 0) + b.position.cost;
  }

  const currencies = [...new Set(filtered.map((t) => t.currency))].sort((a, b) => (a === 'USDT' ? -1 : b === 'USDT' ? 1 : 0));
  const segCounts = Object.fromEntries(SEGMENTS.map((s) => [s.id, rows.filter((t) => t.seg?.id === s.id).length]));

  // Opening trade of a closed trade: the nearest earlier trade on the same bot/symbol/mode that did not close anything.
  const entryFor = (t) => {
    const i = rows.findIndex((x) => x._id === t._id);
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[j];
      if (x.symbol === t.symbol && x.mode === t.mode && (x.botId || null) === (t.botId || null) && x.pnl === undefined) return x;
    }
    return null;
  };
  const journalFor = (t) => (journal || []).find((j) => j.botId && j.botId === t.botId && Math.abs(j.closedAt - t.time) < 120e3) || null;

  // Ledger grouped by day, newest first.
  const groups = [];
  for (const t of filtered.slice(0, shown)) {
    const k = dayKey(t.time);
    if (groups[groups.length - 1]?.key !== k) groups.push({ key: k, trades: [] });
    groups[groups.length - 1].trades.push(t);
  }
  const dayNet = (key) => {
    const net = {};
    for (const t of filtered) if (t.pnl !== undefined && dayKey(t.time) === key) net[t.currency] = (net[t.currency] || 0) + t.pnl;
    return Object.entries(net);
  };

  const exportCsv = () => {
    const head = 'time,mode,market,exchange,bot,symbol,side,position,qty,price,value,fee,currency,invested,pnl,pnl_pct,result,why,reason';
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = filtered.map((t) => [new Date(t.time).toISOString(), t.mode, t.seg?.label, t.exchange || 'binance', esc(t.botName), t.symbol, t.side, t.positionSide || '', t.qty, t.price, t.cost, t.fee, t.currency,
      t.pnl === undefined ? '' : investedIn(t).toFixed(2), t.pnl ?? '', t.pnlPct ?? '',
      t.pnl === undefined ? 'opened' : t.pnl > 0 ? 'profit' : t.pnl < 0 ? 'loss' : 'even', esc(t.pnl === undefined ? '' : reasonOf(t.reason).label), esc(t.reason)].join(','));
    const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `pnl-history-${period}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const quick = (days) => { setFromStr(toLocalInput(startOfToday() - (days - 1) * DAY)); setToStr(toLocalInput(Date.now())); resetPage(); };
  const thisMonth = () => { const d = new Date(); setFromStr(toLocalInput(new Date(d.getFullYear(), d.getMonth(), 1).getTime())); setToStr(toLocalInput(Date.now())); resetPage(); };

  return (
    <>
      <div className="card pnl-filters">
        <div className="pnl-filter"><span className="tiny muted">Time</span><Seg value={period} onChange={(v) => { setPeriod(v); resetPage(); }} options={PERIODS} /></div>
        <div className="pnl-filter"><span className="tiny muted">Account</span><Seg value={mode} onChange={(v) => { setMode(v); resetPage(); }} options={[{ value: 'all', label: 'All' }, { value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} /></div>
        <div className="pnl-filter"><span className="tiny muted">Result</span><Seg value={result} onChange={(v) => { setResult(v); resetPage(); }} options={[{ value: 'all', label: 'All' }, { value: 'profit', label: 'Profit' }, { value: 'loss', label: 'Loss' }, { value: 'open', label: 'Opened' }]} /></div>
        <div className="pnl-filter">
          <span className="tiny muted">Market</span>
          <select className="select" value={market} onChange={(e) => { setMarket(e.target.value); resetPage(); }} style={{ minWidth: 170 }}>
            <option value="all">All markets</option>
            {SEGMENTS.map((s) => <option key={s.id} value={s.id}>{s.label} ({segCounts[s.id]})</option>)}
          </select>
        </div>
        <button className="btn sm" onClick={exportCsv} disabled={!filtered.length} style={{ marginLeft: 'auto', alignSelf: 'flex-end' }}><Download size={13} /> CSV</button>
        {period === 'custom' && (
          <div className="custom-range">
            <label className="pnl-filter"><span className="tiny muted">From (date &amp; time)</span><input className="input" type="datetime-local" value={fromStr} max={toStr} onChange={(e) => { setFromStr(e.target.value); resetPage(); }} /></label>
            <label className="pnl-filter"><span className="tiny muted">To (date &amp; time)</span><input className="input" type="datetime-local" value={toStr} min={fromStr} onChange={(e) => { setToStr(e.target.value); resetPage(); }} /></label>
            <div className="row wrap" style={{ gap: 6, alignSelf: 'flex-end' }}>
              <button className="btn sm ghost" onClick={() => quick(1)}>Today</button>
              <button className="btn sm ghost" onClick={() => { const y = startOfToday() - DAY; setFromStr(toLocalInput(y)); setToStr(toLocalInput(startOfToday() - 60e3)); resetPage(); }}>Yesterday</button>
              <button className="btn sm ghost" onClick={() => quick(7)}>This week</button>
              <button className="btn sm ghost" onClick={thisMonth}>This month</button>
              <button className="btn sm ghost" onClick={() => setToStr(toLocalInput(Date.now()))}>To = now</button>
            </div>
          </div>
        )}
      </div>

      {!trades ? <div className="skeleton" style={{ height: 220 }} />
        : currencies.length ? currencies.map((c) => <CurrencySummary key={c} currency={c} range={range} openCost={openCost[c]} trades={filtered.filter((t) => t.currency === c)} />)
          : <div className="card"><Empty icon={HistoryIcon} title="No trades in this time range">Pick a longer range, or change the market / account filter.</Empty></div>}

      {(insights?.commonMistakes?.length > 0 || insights?.insights?.length > 0) && (
        <div className="card">
          <div className="card-head"><span className="card-title"><Lightbulb size={14} /> AI Journal · what keeps causing losses</span><span className="tiny dim">last {insights.totalTrades} bot trades</span></div>
          {insights.insights?.length > 0 && <ul className="list-reasons">{insights.insights.map((x) => <li key={x}>{x}</li>)}</ul>}
          {insights.commonMistakes?.length > 0 && (
            <div className="col" style={{ gap: 8, marginTop: 10 }}>
              {insights.commonMistakes.slice(0, 4).map((m) => (
                <div key={m.key} className="row between small wrap" style={{ gap: 10 }}>
                  <span><b className="down">{m.pctOfLosses}% of losses</b> <span className="muted">· {m.rule}</span></span>
                  <span className="tiny dim">{m.count} trade{m.count === 1 ? '' : 's'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="card">
          <div className="card-head">
            <span className="card-title"><HistoryIcon size={14} /> Trade by trade <span className="tiny dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· click a profit/loss row to see why</span></span>
            <span className="legend tiny"><span><i style={{ background: 'var(--up)' }} />profit</span><span><i style={{ background: 'var(--down)' }} />loss</span><span><i style={{ background: 'var(--text-3)' }} />opened (not closed yet)</span></span>
          </div>
          <div className="table-wrap">
            <table className="pnl-table">
              <thead><tr><th>Time</th><th>Market</th><th>Pair</th><th>Side</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Value</th><th>Result</th><th className="hide-sm">Why / bot</th><th /></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <DayGroup key={g.key} g={g} net={dayNet(g.key)} open={open} setOpen={setOpen} entryFor={entryFor} journalFor={journalFor} />
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > shown && <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}><button className="btn sm" onClick={() => setShown(shown + PAGE)}>Show more ({filtered.length - shown} left)</button></div>}
          {trades.length >= 1000 && <div className="tiny dim" style={{ marginTop: 8 }}>Showing your latest 1,000 trades.</div>}
        </div>
      )}
    </>
  );
}

function DayGroup({ g, net, open, setOpen, entryFor, journalFor }) {
  const closed = g.trades.filter((t) => t.pnl !== undefined);
  const w = closed.filter((t) => t.pnl > 0).length;
  const l = closed.filter((t) => t.pnl < 0).length;
  return (
    <>
      <tr className="day-row">
        <td colSpan={10}>
          <div className="row between wrap" style={{ gap: 8 }}>
            <b>{dayLabel(g.key)}</b>
            <span className="row" style={{ gap: 12 }}>
              {closed.length > 0 && <span className="tiny muted"><span className="up">{w} win</span> · <span className="down">{l} loss</span></span>}
              {net.length ? net.map(([c, v]) => <b key={c} className={`mono ${tone(v)}`}>{v > 0 ? '+' : ''}{fmtMoney(v, c)}</b>) : <span className="tiny dim">no closed trades</span>}
            </span>
          </div>
        </td>
      </tr>
      {g.trades.map((t) => {
        const cls = t.pnl === undefined ? 'entry' : t.pnl > 0 ? 'profit' : t.pnl < 0 ? 'loss' : 'flat';
        const fut = t.seg && t.seg.id !== 'spot' && t.seg.id !== 'stocks';
        const canOpen = t.pnl !== undefined;
        const isOpen = open === t._id;
        return (
          <Fragment key={t._id}>
            <tr className={`pnl-row ${cls} ${canOpen ? 'clickable' : ''} ${isOpen ? 'expanded' : ''}`} onClick={canOpen ? () => setOpen(isOpen ? null : t._id) : undefined}>
              <td className="small muted mono">{timeOf(t.time)}</td>
              <td>
                <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  <span className={`mkt-tag ${t.seg?.id || 'spot'}`}>{t.seg?.tag || 'SPOT'}</span>
                  {fut && <span className={`badge ${t.positionSide === 'short' ? 'short' : 'long'}`}>{t.positionSide === 'short' ? 'SHORT' : 'LONG'}{t.leverage ? ` ${t.leverage}x` : ''}</span>}
                  <span className={`badge ${t.mode === 'live' ? 'down' : 'flat'}`}>{t.mode === 'live' ? 'LIVE' : 'paper'}</span>
                </div>
              </td>
              <td><div className="coin"><CoinIcon symbol={t.symbol} size={22} />{baseOf(t.symbol)}</div></td>
              <td><span className={`badge ${t.side === 'BUY' ? 'buy' : 'sell'}`}>{t.side}</span></td>
              <td className="num">{fmtQty(t.qty)}</td>
              <td className="num">{fmtPrice(t.price)}</td>
              <td className="num">{fmtMoney(t.cost, t.currency)}</td>
              <td><ResultPill t={t} currency={t.currency} /></td>
              <td className="small muted hide-sm">{canOpen && <b style={{ color: 'var(--text-2)' }}>{reasonOf(t.reason).label} · </b>}{t.botName}</td>
              <td className="dim">{canOpen && (isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />)}</td>
            </tr>
            {isOpen && (
              <tr className={`story-row ${cls}`}><td colSpan={10}><TradeStory t={t} entry={entryFor(t)} journal={journalFor(t)} /></td></tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
