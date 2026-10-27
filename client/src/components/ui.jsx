import { Loader2 } from 'lucide-react';
import { baseOf } from '../lib/format.js';

const COIN_COLORS = {
  BTC: '#f7931a', ETH: '#8c9eff', BNB: '#f3ba2f', SOL: '#14f195', XRP: '#9aa5bd', ADA: '#3c8cff', DOGE: '#c2a633',
  AVAX: '#e84142', DOT: '#e6007a', LINK: '#2a5ada', MATIC: '#8247e5', POL: '#8247e5', TRX: '#ff3b3b', LTC: '#bfbbbb',
  USDT: '#26a17b', USDC: '#2775ca', TON: '#0098ea', SHIB: '#ffa409', PEPE: '#4c9a2a', SUI: '#4da2ff',
};

export function CoinIcon({ symbol, size = 26 }) {
  const base = baseOf(symbol);
  const color = COIN_COLORS[base] || `hsl(${[...base].reduce((s, c) => s + c.charCodeAt(0), 0) % 360} 70% 60%)`;
  return (
    <span className="coin-icon" style={{ background: color, width: size, height: size, fontSize: size * 0.36 }}>
      {base.slice(0, 3)}
    </span>
  );
}

export function ActionBadge({ action }) {
  const a = (action || 'HOLD').toUpperCase();
  return <span className={`badge ${a.toLowerCase()}`}>{a}</span>;
}

export function Spinner({ size = 16 }) {
  return <Loader2 size={size} className="spin" />;
}

export function Switch({ checked, onChange }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Seg({ options, value, onChange, className = '' }) {
  return (
    <div className={`seg ${className}`}>
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return (
          <button key={v} className={`${value === v ? 'on' : ''} ${v}`} onClick={() => onChange(v)} type="button">
            {l}
          </button>
        );
      })}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="empty">
      {Icon && <Icon size={30} strokeWidth={1.5} />}
      <div className="bold" style={{ color: 'var(--text-2)' }}>{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

// Semicircle gauge from -100 (strong sell) to +100 (strong buy).
export function ScoreGauge({ score = 0, label, display, color: colorOverride }) {
  const pct = (score + 100) / 200;
  const angle = Math.PI * (1 - pct);
  const r = 80;
  const cx = 100;
  const cy = 95;
  const x = cx + r * Math.cos(angle);
  const y = cy - r * Math.sin(angle);
  const color = colorOverride || (score >= 30 ? 'var(--up)' : score <= -30 ? 'var(--down)' : 'var(--warn)');
  return (
    <div className="gauge">
      <svg viewBox="0 0 200 110" width="100%">
        <defs>
          <linearGradient id="gg" x1="0" x2="1">
            <stop offset="0" stopColor="#ea3943" />
            <stop offset="0.5" stopColor="#f5a524" />
            <stop offset="1" stopColor="#16c784" />
          </linearGradient>
        </defs>
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} stroke="#1c2335" strokeWidth="14" fill="none" strokeLinecap="round" />
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} stroke="url(#gg)" strokeWidth="14" fill="none" strokeLinecap="round" opacity="0.85" />
        <circle cx={x} cy={y} r="9" fill="#06080d" stroke={color} strokeWidth="4" />
      </svg>
      <div className="gauge-value">
        <b style={{ color }}>{display ?? (score > 0 ? `+${score}` : score)}</b>
        <span className="tiny muted">{label}</span>
      </div>
    </div>
  );
}

// Centered bar for a component score in [-100, 100].
export function ScoreBar({ value = 0 }) {
  const w = Math.min(50, Math.abs(value) / 2);
  return (
    <div className="meter center">
      <i style={{ left: value >= 0 ? '50%' : `${50 - w}%`, width: `${w}%`, background: value >= 0 ? 'var(--up)' : 'var(--down)' }} />
    </div>
  );
}

export function FearGreed({ data }) {
  if (!data) return <div className="skeleton" style={{ height: 120 }} />;
  const v = data.value;
  const color = v < 25 ? '#ea3943' : v < 45 ? '#f5864a' : v < 55 ? '#f5a524' : v < 75 ? '#9bd33a' : '#16c784';
  return <ScoreGauge score={Math.round((v - 50) * 2)} display={v} label={data.label} color={color} />;
}

export const REGIME_STYLE = {
  BULL_TREND: { label: 'Bull Trend', color: '#16c784' },
  BEAR_TREND: { label: 'Bear Trend', color: '#ea3943' },
  SIDEWAYS: { label: 'Sideways', color: '#8792ab' },
  HIGH_VOLATILITY: { label: 'High Volatility', color: '#f5a524' },
  LOW_VOLATILITY: { label: 'Low Volatility', color: '#3987e5' },
  BREAKOUT: { label: 'Breakout', color: '#00e5c0' },
  BREAKDOWN: { label: 'Breakdown', color: '#d55181' },
  PANIC: { label: 'Panic', color: '#b4141e' },
};
const regimeKey = (r) => (REGIME_STYLE[r] ? r : Object.keys(REGIME_STYLE).find((k) => REGIME_STYLE[k].label === r));

export function RegimeChip({ regime }) {
  const st = REGIME_STYLE[regimeKey(regime)] || { label: regime || '—', color: '#8792ab' };
  return <span className="regime-chip"><i style={{ background: st.color }} />{st.label}</span>;
}

export function SignalBadge({ signal, big }) {
  const s = (signal || 'WAIT').toUpperCase();
  return <span className={`badge ${s.toLowerCase()} ${big ? 'big' : ''}`}>{s}</span>;
}

export function GradeBadge({ grade }) {
  return grade ? <span className={`badge grade-${grade}`} title="Signal quality grade (A best)">Grade {grade}</span> : null;
}

export function DecisionBadge({ decision }) {
  if (!decision) return null;
  return <span className={`badge ${decision === 'APPROVED' ? 'approved' : 'rejected'}`}>{decision}</span>;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.value} className={value === t.value ? 'on' : ''} onClick={() => onChange(t.value)} type="button">
          {t.icon && <t.icon size={14} />}{t.label}
        </button>
      ))}
    </div>
  );
}

// Categorical palette (validated, dark mode) - assigned in fixed order.
export const CATEGORICAL = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

// Donut for parts of a whole: 2px surface gaps between segments, legend always present.
export function Donut({ items, size = 180, centerLabel, centerValue }) {
  const total = items.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2 - 14;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="row wrap" style={{ gap: 20, alignItems: 'center' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Allocation">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1c2335" strokeWidth="22" />
        {items.map((it) => {
          const len = (it.value / total) * c;
          const seg = (
            <circle key={it.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={it.color} strokeWidth="22"
              strokeDasharray={`${Math.max(0, len - 2)} ${c - Math.max(0, len - 2)}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}>
              <title>{`${it.label}: ${((it.value / total) * 100).toFixed(1)}%`}</title>
            </circle>
          );
          offset += len;
          return seg;
        })}
        <text x="50%" y="47%" textAnchor="middle" fill="var(--text)" fontSize="18" fontWeight="700" fontFamily="JetBrains Mono">{centerValue}</text>
        <text x="50%" y="60%" textAnchor="middle" fill="var(--text-2)" fontSize="11">{centerLabel}</text>
      </svg>
      <div className="col" style={{ gap: 8, minWidth: 160 }}>
        {items.map((it) => (
          <div key={it.label} className="row between small" style={{ gap: 16 }}>
            <span className="row" style={{ gap: 8 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: it.color, display: 'inline-block' }} />{it.label}</span>
            <span className="mono">{((it.value / total) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Diverging color: red (-1) -> neutral gray (0) -> teal (+1).
export function divergingColor(v) {
  const t = Math.max(-1, Math.min(1, v));
  const mix = (a, b, k) => a.map((x, i) => Math.round(x + (b[i] - x) * k));
  const neutral = [42, 49, 66];
  const pos = [0, 168, 140];
  const neg = [200, 50, 60];
  const [r, g, b] = t >= 0 ? mix(neutral, pos, t) : mix(neutral, neg, -t);
  return `rgb(${r},${g},${b})`;
}

export function Heatmap({ labels, matrix }) {
  if (!labels?.length) return null;
  return (
    <div className="table-wrap">
      <table className="heat">
        <thead><tr><th />{labels.map((l) => <th key={l}>{l}</th>)}</tr></thead>
        <tbody>
          {matrix.map((row, i) => (
            <tr key={labels[i]}>
              <th>{labels[i]}</th>
              {row.map((v, j) => (
                <td key={j}><div style={{ background: divergingColor(v) }} title={`${labels[i]} vs ${labels[j]}: ${v.toFixed(2)}`}>{v.toFixed(2)}</div></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Histogram of a distribution; bars below zero in red, above in teal; hover shows the bin.
export function Histogram({ bins, zeroAt = 0, unit = '%' }) {
  const max = Math.max(...bins.map((b) => b.count), 1);
  return (
    <div className="hist">
      {bins.map((b, k) => (
        <div key={k} style={{ height: `${(b.count / max) * 100}%`, background: b.from < zeroAt ? 'rgba(234,57,67,0.75)' : 'rgba(0,229,192,0.75)' }}
          title={`${b.from}${unit} … : ${b.count} runs`} />
      ))}
    </div>
  );
}
