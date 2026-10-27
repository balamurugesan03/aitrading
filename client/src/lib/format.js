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

export const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

// Crypto pairs (BTCUSDT), NSE forex pairs (USDINR -> USD / INR) and NSE stocks (RELIANCE, quoted in INR).
const QUOTE_RE = /(USDT|USDC|FDUSD|INR|BTC|ETH|BNB)$/;
export const baseOf = (symbol) => symbol.replace(QUOTE_RE, '');
export const quoteOf = (symbol) => symbol.match(QUOTE_RE)?.[1] || 'INR';
export const FX_PAIRS = ['USDINR', 'EURINR', 'GBPINR', 'JPYINR'];
export const isCryptoSymbol = (symbol) => /(USDT|USDC|FDUSD|BTC|ETH|BNB)$/.test(symbol);

// Money in the account currency: rupees (Indian grouping) for the forex account, dollars for crypto.
export const fmtMoney = (v, currency = 'USDT', d = 2) => {
  if (currency !== 'INR') return fmtUsd(v, d);
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${v < 0 ? '-' : ''}₹${Math.abs(Number(v)).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
