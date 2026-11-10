import { PieChart, Network, AlertTriangle, Lightbulb, LineChart } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll } from '../lib/hooks.js';
import { Donut, Heatmap, CATEGORICAL, CoinIcon, Empty, Spinner } from '../components/ui.jsx';
import { EquityChart } from '../components/CandleChart.jsx';
import { fmtUsd, fmtPct, fmtQty, tone } from '../lib/format.js';

const RISK_TONE = { NONE: 'flat', LOW: 'up', MEDIUM: 'warn', HIGH: 'down' };

export default function Portfolio() {
  const { mode, exchange, money, market } = useApp();
  const [pf, err] = usePoll(`/portfolio/ai?mode=${mode}&exchange=${exchange}`, 30000, [mode, exchange]);
  const [equity] = usePoll(`/equity?mode=${mode}&exchange=${exchange}`, 300000, [mode, exchange]);
  const fmtUsd = money; // values are in the account currency (INR for the forex account)
  if (err) return <div className="alert error">{err}</div>;
  if (!pf) return <div className="empty"><Spinner /> Analysing portfolio…</div>;

  // Allocation: up to 7 named assets in fixed categorical order, the rest folded into "Other".
  const risky = pf.assets.filter((a) => !a.stable && a.value > 1);
  const named = risky.slice(0, 6);
  const other = risky.slice(6).reduce((s, a) => s + a.value, 0);
  const stable = pf.assets.filter((a) => a.stable).reduce((s, a) => s + a.value, 0);
  const items = [
    ...named.map((a, k) => ({ label: a.asset, value: a.value, color: CATEGORICAL[k] })),
    ...(other > 0 ? [{ label: 'Other', value: other, color: CATEGORICAL[6] }] : []),
    ...(stable > 0 ? [{ label: market === 'crypto' ? 'Stablecoins' : pf.margin ? 'Free margin' : 'INR cash', value: stable, color: '#5b6478' }] : []),
  ];

  return (
    <>
      <div className="grid g-4">
        <div className="card stat"><span className="stat-label">Portfolio value · {mode}</span><span className="stat-value">{fmtUsd(pf.total)}</span></div>
        {pf.margin
          ? <div className="card stat"><span className="stat-label">Margin used</span><span className="stat-value">{pf.exposurePct.toFixed(1)}%</span><span className="stat-sub muted">leverage {pf.margin.leverage.toFixed(2)}x · notional {fmtUsd(pf.margin.notional, 0)} · free {fmtUsd(pf.margin.freeMargin, 0)}</span></div>
          : <div className="card stat"><span className="stat-label">Market exposure</span><span className="stat-value">{pf.exposurePct.toFixed(1)}%</span><span className="stat-sub muted">stablecoins {pf.stablePct.toFixed(1)}%</span></div>}
        <div className="card stat"><span className="stat-label">Portfolio volatility (annualised)</span><span className="stat-value">{pf.annualVolPct}%</span><span className="stat-sub muted">from hourly returns + correlations</span></div>
        <div className="card stat"><span className="stat-label">Portfolio risk</span><span className={`stat-value ${RISK_TONE[pf.riskLevel]}`}>{pf.riskLevel}</span><span className="stat-sub muted">{pf.warnings.length} warning(s)</span></div>
      </div>

      <div className="grid g-2">
        <div className="card">
          <div className="card-head"><span className="card-title"><PieChart size={14} /> Allocation</span></div>
          <Donut items={items} centerValue={fmtUsd(pf.total, 0)} centerLabel="total value" />
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title"><Network size={14} /> Correlation Matrix (1h returns, 8 days)</span></div>
          {pf.correlation.assets.length >= 2 ? (
            <>
              <Heatmap labels={pf.correlation.assets} matrix={pf.correlation.matrix} />
              <div className="legend" style={{ marginTop: 10 }}>
                <span><i style={{ background: 'rgb(200,50,60)' }} />-1 opposite</span><span><i style={{ background: 'rgb(42,49,66)' }} />0 unrelated</span><span><i style={{ background: 'rgb(0,168,140)' }} />+1 move together</span>
              </div>
              <div className="tiny dim" style={{ marginTop: 6 }}>Above 0.8, two holdings behave like one bet — the Risk Engine limits how many it allows.</div>
            </>
          ) : <Empty icon={Network} title="Hold at least two crypto assets to see correlations" />}
        </div>
      </div>

      <div className="grid g-wide">
        <div className="card">
          <div className="card-head"><span className="card-title"><LineChart size={14} /> Equity Curve</span><span className="tiny dim">snapshot every 5 minutes</span></div>
          {equity?.length > 2 ? <EquityChart points={equity} height={260} /> : <Empty icon={LineChart} title="Collecting equity snapshots…">The curve fills in as the server records your equity every 5 minutes.</Empty>}
        </div>
        <div className="col" style={{ gap: 18 }}>
          <div className="card">
            <div className="card-head"><span className="card-title"><AlertTriangle size={14} /> Warnings</span></div>
            {pf.warnings.length ? pf.warnings.map((w) => <div key={w} className="alert warn small" style={{ marginBottom: 8 }}>{w}</div>) : <div className="small up">No concentration or correlation issues.</div>}
          </div>
          <div className="card">
            <div className="card-head"><span className="card-title"><Lightbulb size={14} /> AI Recommendations</span></div>
            {pf.recommendations.length ? <ul className="list-reasons">{pf.recommendations.map((r) => <li key={r}>{r}</li>)}</ul> : <div className="small muted">Allocation looks balanced.</div>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><span className="card-title">Holdings</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Asset</th><th className="num">Amount</th><th className="num">Price</th><th className="num">Value</th><th className="num">Weight</th><th className="num">24h</th></tr></thead>
            <tbody>
              {pf.assets.map((a) => (
                <tr key={a.asset}>
                  <td><div className="coin"><CoinIcon symbol={market === 'crypto' ? `${a.asset}USDT` : a.asset} size={22} />{a.asset}{a.liqPrice ? <span className="tiny dim">&nbsp;{a.side} {a.leverage}x · liq {fmtUsd(a.liqPrice, a.liqPrice < 1 ? 5 : 2)}{a.fundingPaid ? ` · funding ${fmtUsd(-a.fundingPaid)}` : ''}</span> : null}</div></td>
                  <td className="num">{fmtQty(a.amount)}</td>
                  <td className="num">{fmtUsd(a.price, a.price < 1 ? 5 : 2)}</td>
                  <td className="num">{fmtUsd(a.value)}</td>
                  <td className="num">{a.weightPct.toFixed(1)}%</td>
                  <td className={`num ${tone(a.change)}`}>{a.stable ? '—' : fmtPct(a.change)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pf.openPositions.length > 0 && <div className="tiny dim" style={{ marginTop: 8 }}>{pf.openPositions.length} bot position(s) open: {pf.openPositions.map((p) => p.bot).join(', ')}</div>}
      </div>
    </>
  );
}
