export const fmtPrice = (v) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const n = Number(v);
  const d = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 5 : 8;
  return n.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
};

export const fmtUsd = (v, d = 2) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;

export const fmtPct = (v, d = 2) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);

export const fmtCompact = (v) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v || 0);

export const fmtQty = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 }));

export const fmtTime = (t) => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export const ago = (t) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// P&L of an open bot position if it were closed now, AFTER the exit fee - the number take-profit / stop-loss
// trigger on. `live` comes from the server's position guard (every ~2 s, exact fee and bid/ask); without a recent
// one it is estimated from the last price with a 0.1% exit fee.
export const openNetPnl = (pos, price, live) => {
  if (live && Date.now() - (live.at || 0) < 15000) return { pnl: live.netPnl, pct: live.netPct, exact: true };
  if (!pos || !price) return { pnl: null, pct: null };
  const short = pos.side === 'short';
  const fee = price * pos.qty * 0.001;
  const pnl = short ? pos.cost - price * pos.qty - fee : price * pos.qty - fee - pos.cost;
  return { pnl, pct: pos.cost ? (pnl / pos.cost) * 100 : null, exact: false };
};

// Trade duration (minutes) as text: 15 -> "15 min", 60 -> "1 h", 1440 -> "1 day".
export const fmtDuration = (min) => {
  const m = Math.max(0, Math.round(min));
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${m} min`;
};
// Time left until a trade's duration expires.
export const durationLeft = (openedAt, maxHoldMin) => fmtDuration(Math.ceil((openedAt + maxHoldMin * 60000 - Date.now()) / 60000));

export const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

// Crypto pairs (BTCUSDT), NSE forex pairs (USDINR -> USD / INR) and NSE stocks (RELIANCE, quoted in INR).
const QUOTE_RE = /(USDT|USDC|FDUSD|INR|BTC|ETH|BNB)$/;
export const baseOf = (symbol) => symbol.replace(QUOTE_RE, '');
export const quoteOf = (symbol) => symbol.match(QUOTE_RE)?.[1] || 'INR';
export const FX_PAIRS = ['USDINR', 'EURINR', 'GBPINR', 'JPYINR'];
export const INDEX_FUTURES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']; // NSE futures also cover F&O stocks
export const isCryptoSymbol = (symbol) => /(USDT|USDC|FDUSD|BTC|ETH|BNB)$/.test(symbol);

// Money in the account currency: rupees (Indian grouping) for the forex account, dollars for crypto.
export const fmtMoney = (v, currency = 'USDT', d = 2) => {
  if (currency !== 'INR') return fmtUsd(v, d);
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${v < 0 ? '-' : ''}₹${Math.abs(Number(v)).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
