import { Brain, Sparkles, ShieldAlert, ShieldCheck, Layers, Target, CheckCircle2, XCircle, ListChecks } from 'lucide-react';
import { SignalBadge, GradeBadge, DecisionBadge, RegimeChip, ScoreBar } from './ui.jsx';
import { fmtPrice, fmtPct, fmtUsd } from '../lib/format.js';

export default function SignalPanel({ signal }) {
  const { models, claude, risk, regime } = signal;
  const d = claude?.decision;
  const sigColor = signal.signal === 'LONG' ? 'up' : signal.signal === 'EXIT' || signal.signal === 'SHORT' ? 'down' : 'muted';

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="signal-top">
        <div>
          <div className="tiny dim">AI SIGNAL · {signal.strategyName}</div>
          <div className={`signal-word ${sigColor}`}>{signal.signal}</div>
        </div>
        <div className="col" style={{ alignItems: 'flex-end', gap: 6 }}>
          <GradeBadge grade={signal.quality} />
          {risk && <span className="row tiny" style={{ gap: 6 }}>Trade <DecisionBadge decision={risk.decision} /></span>}
        </div>
      </div>

      <div className="signal-hero">
        <div><small>Probability</small><b>{(signal.probability * 100).toFixed(0)}%</b><div className="tiny dim">{signal.probabilitySamples} similar past setups</div></div>
        <div><small>Expected return</small><b className={signal.expectedReturnPct > 0 ? 'up' : 'down'}>{fmtPct(signal.expectedReturnPct)}</b><div className="tiny dim">after fees &amp; slippage</div></div>
        <div><small>Expected risk</small><b className="down">-{signal.expectedRiskPct.toFixed(2)}%</b><div className="tiny dim">to stop-loss</div></div>
        <div><small>Reward : Risk</small><b>{signal.rr.toFixed(2)}</b><div className="tiny dim">edge {signal.edgeR > 0 ? '+' : ''}{signal.edgeR}R per trade</div></div>
      </div>

      <div className="col" style={{ gap: 6 }}>
        <div className="row between"><span className="card-title"><Layers size={14} /> Market Regime</span>{regime && <RegimeChip regime={regime.name} />}</div>
        {regime && <div className="small muted">{regime.description} <span className="dim">Confidence {(regime.confidence * 100).toFixed(0)}% → {regime.recommended}.</span></div>}
      </div>

      <div className="divider" />
      <div>
        <div className="row between" style={{ marginBottom: 10 }}>
          <span className="card-title"><Brain size={14} /> 7-Model Ensemble</span>
          <span className="mono small">meta score {signal.score > 0 ? '+' : ''}{signal.score}</span>
        </div>
        <div className="col" style={{ gap: 8 }}>
          {Object.entries(models).map(([k, m]) => (
            <div className="comp-row" key={k} title={(m.notes || []).join(' · ')}>
              <span className="muted">{m.label}{signal.weights?.[k] ? <span className="dim tiny"> ×{signal.weights[k]}</span> : ''}</span>
              <ScoreBar value={m.score} />
              <span className={`mono num ${m.score > 0 ? 'up' : m.score < 0 ? 'down' : 'flat'}`}>{m.score > 0 ? `+${m.score}` : m.score}</span>
            </div>
          ))}
        </div>
        <div className="tiny dim" style={{ marginTop: 6 }}>Weights come from the strategy the regime selected. Hover a row for its reasons.</div>
      </div>

      {risk?.steps?.length > 0 && (
        <>
          <div className="divider" />
          <div>
            <div className="row between" style={{ marginBottom: 10 }}>
              <span className="card-title"><ShieldCheck size={14} /> Dynamic Risk Engine</span>
              <span className="mono small">final risk {risk.finalRiskPct}%</span>
            </div>
            <div className="steps">
              {risk.steps.map((s) => (
                <div className="step-row" key={s.name}>
                  <span className={s.factor < 1 ? 'down' : s.factor > 1 ? 'up' : 'dim'}>{s.factor < 1 ? '▼' : s.factor > 1 ? '▲' : '•'}</span>
                  <span>{s.name}</span>
                  <span className="note" title={s.note}>{s.note}</span>
                  <span className="mono num">{s.riskAfter}%</span>
                </div>
              ))}
            </div>
            <div className="card-title" style={{ margin: '14px 0 8px' }}><ListChecks size={14} /> Safety gates</div>
            <div className="steps">
              {risk.gates.map((g) => (
                <div className="gate-row" key={g.name}>
                  {g.pass ? <CheckCircle2 size={14} className="up" /> : <XCircle size={14} className="down" />}
                  <span>{g.name}</span>
                  <span className="note small muted">{g.note}</span>
                </div>
              ))}
            </div>
            {risk.position && <div className="alert info" style={{ marginTop: 10 }}>Approved size: <b>{fmtUsd(risk.position.notional)}</b>, risking {fmtUsd(risk.position.riskAmount)}</div>}
          </div>
        </>
      )}

      <div className="divider" />
      <div>
        <div className="card-title" style={{ marginBottom: 10 }}><Target size={14} /> Trade Plan</div>
        <div className="kv">
          <span>Entry</span><span>{fmtPrice(signal.price)}</span>
          <span>Stop-loss</span><span className="down">{fmtPrice(signal.stopLoss)}</span>
          <span>Take-profit</span><span className="up">{fmtPrice(signal.takeProfit)}</span>
          <span>Neural net P(up)</span><span>{(signal.ml.probUp * 100).toFixed(1)}% · acc {signal.ml.accuracy != null ? `${(signal.ml.accuracy * 100).toFixed(1)}%` : '—'}</span>
          {signal.sentiment && <><span>Fear &amp; Greed</span><span>{signal.sentiment.value} · {signal.sentiment.label}</span></>}
        </div>
      </div>

      {signal.reasons?.length > 0 && <div className="alert warn small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{signal.reasons.map((r) => <span key={r}>{r}</span>)}</div>}

      {d && (
        <div className="ai-reason">
          <div className="row between" style={{ marginBottom: 8 }}>
            <span className="row bold" style={{ gap: 6 }}><Sparkles size={15} color="#b3a1ff" /> Claude AI review</span>
            <span className="row" style={{ gap: 6 }}><SignalBadge signal={d.action === 'BUY' ? 'LONG' : d.action === 'SELL' ? 'EXIT' : 'WAIT'} /><span className="badge ai">{d.confidence}%</span></span>
          </div>
          <div>{d.reasoning}</div>
          {d.keyRisks?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="row tiny bold" style={{ gap: 6, color: 'var(--warn)', marginBottom: 4 }}><ShieldAlert size={13} /> KEY RISKS</div>
              <ul className="list-reasons">{d.keyRisks.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
          <div className="tiny dim" style={{ marginTop: 8 }}>{claude.model} · levels: SL {fmtPrice(d.stopLoss)} / TP {fmtPrice(d.takeProfit)}</div>
        </div>
      )}
      {claude?.error && <div className="alert warn"><Brain size={15} /> Claude: {claude.error}</div>}

      {signal.drivers?.length > 0 && (
        <div>
          <div className="card-title" style={{ marginBottom: 6 }}><Brain size={14} /> Key Drivers</div>
          <ul className="list-reasons">{signal.drivers.map((dr, k) => <li key={k}><b className={dr.score > 0 ? 'up' : 'down'}>{dr.model}</b>: {dr.note}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
