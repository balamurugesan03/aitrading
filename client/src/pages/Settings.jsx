import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Database, KeyRound, RotateCcw, ShieldAlert, CheckCircle2, XCircle, Smartphone } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { Field, Spinner } from '../components/ui.jsx';

const Status = ({ ok, children }) => (
  <span className="row small" style={{ gap: 6 }}>{ok ? <CheckCircle2 size={15} className="up" /> : <XCircle size={15} className="down" />}{children}</span>
);

export default function SettingsPage() {
  const { status, toast, user, exchange, currency, market } = useApp();
  const fx = market !== 'crypto'; // INR wallets (forex, stocks)
  const walletName = { crypto: 'Crypto (USDT)', forex: 'Forex (INR)', stocks: 'Stocks (INR)' }[market] || 'Crypto (USDT)';
  const [amount, setAmount] = useState(fx ? 1000000 : 10000);
  useEffect(() => setAmount(fx ? 1000000 : 10000), [fx]);
  const [clearHistory, setClearHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    if (!confirm(`Reset your ${walletName} paper wallet to ${amount} ${currency}? Its paper bot stats are cleared too.`)) return;
    setBusy(true);
    try {
      await api.post('/portfolio/reset', { amount: +amount, clearHistory, exchange });
      toast('Paper wallet reset');
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(false);
  };

  return (
    <div className="grid g-2">
      <div className="card">
        <div className="card-head"><span className="card-title"><Sparkles size={14} /> Claude AI</span></div>
        <div className="col">
          <Status ok={status?.claude}>{status?.claude ? `Connected · model ${status.claudeModel}` : 'Not configured on this server'}</Status>
          <div className="small muted">Claude powers trade review/veto, news NLP, journal coaching and the AI Assistant.{user?.role === 'admin' && ' Add the key to server/.env:'}</div>
          {user?.role === 'admin' && <pre className="mono small card" style={{ margin: 0, padding: 12 }}>ANTHROPIC_API_KEY=sk-ant-...{'\n'}CLAUDE_MODEL=claude-opus-5-5</pre>}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><span className="card-title"><KeyRound size={14} /> Exchanges</span></div>
        <div className="col">
          <div className="small muted">Connect your own Binance, Bybit or OKX API keys (testnet or live), or Zerodha Kite Connect for NSE forex (USDINR, EURINR, GBPINR, JPYINR) and NSE stocks. Keys are encrypted at rest and only used for your account.</div>
          <Link className="btn primary" to="/account?tab=connections" style={{ alignSelf: 'flex-start' }}>Manage exchange connections</Link>
          <div className="alert warn small"><ShieldAlert size={16} /> <span>Use <b>Spot trading only</b> keys with <b>withdrawals disabled</b> and an IP whitelist. Start on the testnet.</span></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><span className="card-title"><RotateCcw size={14} /> Paper Trading Wallet · {walletName}</span></div>
        <div className="col" style={{ gap: 12 }}>
          <Field label={`Starting balance (${currency})`} hint="Switch the exchange in the top bar to reset another wallet"><input className="input mono" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={clearHistory} onChange={(e) => setClearHistory(e.target.checked)} /> Also clear paper trade history, journal, signals and logs</label>
          <button className="btn danger" onClick={reset} disabled={busy}>{busy ? <Spinner /> : <RotateCcw size={14} />} Reset paper wallet</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><span className="card-title"><Smartphone size={14} /> Mobile app</span></div>
        <div className="small muted col" style={{ gap: 8 }}>
          <span>Install the app on your phone: open this site in Chrome (Android) or Safari (iOS) and choose <b>Add to Home screen</b>. It opens full-screen like a native app, and alerts arrive via the in-app bell, browser notifications and Telegram.</span>
          <span><Link to="/account?tab=telegram">Set up Telegram alerts →</Link></span>
        </div>
      </div>

      {user?.role === 'admin' && (
        <div className="card">
          <div className="card-head"><span className="card-title"><Database size={14} /> Server</span></div>
          <div className="col">
            <Status ok>{status?.db === 'mongodb' ? 'MongoDB connected' : 'Local JSON store (server/data/db.json)'}</Status>
            <div className="small muted">Set <code>MONGO_URI</code> for MongoDB. Back up <code>server/data/master.key</code> (or set <code>MASTER_KEY</code>) — it decrypts every stored exchange key.</div>
          </div>
        </div>
      )}

      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="alert info"><ShieldAlert size={16} /> <span>This is a decision-support and automation tool, not financial advice. Crypto is highly volatile and AI signals can be wrong. Always backtest and paper-trade first, and only risk money you can afford to lose.</span></div>
      </div>
    </div>
  );
}
