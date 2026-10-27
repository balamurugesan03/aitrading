import { Code2, KeyRound, Gauge } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/AppContext.jsx';

const ENDPOINTS = [
  ['Market data', [
    ['GET', '/market/tickers?symbols=BTCUSDT,ETHUSDT&exchange=binance', '24h tickers'],
    ['GET', '/market/klines?symbol=BTCUSDT&interval=1h&limit=500', 'Candles + indicators + regime per candle'],
    ['GET', '/market/orderflow?symbol=BTCUSDT', 'Order Flow AI'],
    ['GET', '/market/futures?symbol=BTCUSDT', 'Futures intelligence (OI, funding, L/S)'],
    ['GET', '/market/news?asset=BTC', 'News with AI sentiment'],
    ['GET', '/market/calendar', 'Economic calendar + macro risk'],
  ]],
  ['AI', [
    ['POST', '/ai/analyze', 'Signal 2.0 + risk-engine decision. Body: { symbol, interval, strategy, exchange }'],
    ['POST', '/ai/scan', 'AI Scanner. Body: { interval, universe, exchange }'],
    ['POST', '/backtest', 'Backtest Lab 2.0. Body: { symbols, intervals, strategy, candles, optimize }'],
  ]],
  ['Trading (needs "trade" scope)', [
    ['GET', '/bots', 'List bots'],
    ['POST', '/bots', 'Create bot. Body: { symbol, interval, strategy, mode, exchange }'],
    ['POST', '/bots/:id/start', 'Start a bot'],
    ['POST', '/bots/:id/stop', 'Stop a bot'],
    ['POST', '/trade', 'Market order. Body: { symbol, side, mode, quoteAmount | quantity, exchange }'],
    ['POST', '/killswitch', 'Stop everything'],
  ]],
  ['Account', [
    ['GET', '/portfolio?mode=paper', 'Balances valued in USDT'],
    ['GET', '/trades?limit=100', 'Trade ledger'],
    ['GET', '/journal', 'AI trade journal'],
    ['GET', '/risk/overview', 'Equity, drawdown, exposure, limits'],
  ]],
];

export default function ApiDocs() {
  const { me } = useApp();
  const base = `${location.origin}/api/v1`;
  return (
    <div className="grid g-wide">
      <div className="col" style={{ gap: 18 }}>
        <div className="card">
          <div className="card-head"><span className="card-title"><Code2 size={14} /> Developer API</span></div>
          <p className="muted small">Automate VelocityX from your own code. Every request authenticates with an API key in the <code>X-API-Key</code> header. Keys are read-only unless created with the <b>trade</b> scope.</p>
          <div className="code-block">{`curl ${base}/market/tickers?symbols=BTCUSDT \\
  -H "X-API-Key: nx_your_key"

curl -X POST ${base}/ai/analyze \\
  -H "X-API-Key: nx_your_key" -H "Content-Type: application/json" \\
  -d '{"symbol":"ETHUSDT","interval":"1h","strategy":"adaptive"}'`}</div>
          <div className="code-block" style={{ marginTop: 10 }}>{`// Node.js / browser
const res = await fetch('${base}/ai/analyze', {
  method: 'POST',
  headers: { 'X-API-Key': process.env.VELOCITYX_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ symbol: 'BTCUSDT', interval: '4h' }),
});
const signal = await res.json(); // { signal, probability, expectedReturnPct, rr, quality, regime, risk }`}</div>
        </div>
        {ENDPOINTS.map(([group, rows]) => (
          <div className="card" key={group}>
            <div className="card-title" style={{ marginBottom: 8 }}>{group}</div>
            {rows.map(([m, path, desc]) => (
              <div className="endpoint" key={m + path}><span className={`m ${m}`}>{m}</span><span><code>{path}</code><div className="tiny muted">{desc}</div></span></div>
            ))}
          </div>
        ))}
      </div>
      <div className="col" style={{ gap: 18 }}>
        <div className="card col" style={{ gap: 10 }}>
          <div className="card-title"><KeyRound size={14} /> Your access</div>
          <Link className="btn primary" to="/account?tab=apikeys">Manage API keys</Link>
        </div>
        <div className="card col" style={{ gap: 8 }}>
          <div className="card-title"><Gauge size={14} /> Rate limits</div>
          <div className="small muted">Requests are limited per IP address (IP_RATE_LIMIT_PER_MIN, default 600/min). Over the limit returns HTTP 429.</div>
        </div>
        <div className="card small muted">Errors are JSON: <code>{'{ "error": "message" }'}</code>. Base URL: <code>{base}</code></div>
      </div>
    </div>
  );
}
