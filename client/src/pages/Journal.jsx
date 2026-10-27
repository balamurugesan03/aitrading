import { NotebookPen, Lightbulb, AlertTriangle, CheckCircle2, XCircle, Sparkles } from 'lucide-react';
import { usePoll, useServerEvents } from '../lib/hooks.js';
import { CoinIcon, RegimeChip, GradeBadge, Empty, Spinner } from '../components/ui.jsx';
import { fmtPrice, fmtUsd, fmtPct, fmtTime, tone, baseOf } from '../lib/format.js';

const MISTAKE_LABEL = {
  wrongDirection: 'Wrong direction', entryLate: 'Late entry', volatility: 'Volatility expanded', gaveBack: 'Gave back profit',
  regimeFlip: 'Regime changed', lowVolume: 'Low-volume entry', lowQuality: 'Low-quality signal',
};

export default function Journal() {
  const [rows, , reload] = usePoll('/journal?limit=100', 30000);
  const [ins, , reloadIns] = usePoll('/journal/insights', 60000);
  useServerEvents((t) => t === 'journal' && (reload(), reloadIns()));
  if (!rows || !ins) return <div className="empty"><Spinner /></div>;

  return (
    <>
      <div className="grid g-wide">
        <div className="card">
          <div className="card-head"><span className="card-title"><Lightbulb size={14} /> AI Insights from {ins.totalTrades} journaled trades</span></div>
          {ins.insights.length ? (
            <div className="col" style={{ gap: 8 }}>{ins.insights.map((i) => <div key={i} className="insight">{i}</div>)}</div>
          ) : <Empty icon={Lightbulb} title="Insights appear after a few closed trades">Each pattern needs at least 3 trades before it is reported.</Empty>}
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title"><AlertTriangle size={14} /> Most Common Mistakes (in losing trades)</span></div>
          {ins.commonMistakes.length ? (
            <div className="col" style={{ gap: 10 }}>
              {ins.commonMistakes.map((m) => (
                <div key={m.key}>
                  <div className="row between small"><b>{MISTAKE_LABEL[m.key] || m.key}</b><span className="mono">{m.count} · {m.pctOfLosses}% of losses</span></div>
                  <div className="meter" style={{ margin: '5px 0' }}><i style={{ left: 0, width: `${m.pctOfLosses}%`, background: 'var(--down)' }} /></div>
                  <div className="tiny muted">{m.rule}</div>
                </div>
              ))}
            </div>
          ) : <div className="small muted">No losing trades analysed yet.</div>}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><span className="card-title"><NotebookPen size={14} /> Trade Journal</span><span className="tiny dim">every closed bot trade, analysed automatically</span></div>
        {rows.length ? (
          <div className="col" style={{ gap: 12 }}>
            {rows.map((j) => (
              <div key={j._id} className="position-box" style={{ borderStyle: 'solid' }}>
                <div className="row wrap between" style={{ gap: 10 }}>
                  <div className="coin"><CoinIcon symbol={j.symbol} size={28} /><div><div className="bold">{baseOf(j.symbol)} · {j.botName}</div><div className="tiny dim">{fmtTime(j.openedAt)} → {fmtTime(j.closedAt)} · {j.exitReason}</div></div></div>
                  <div className="row wrap" style={{ gap: 8 }}>
                    {j.entryContext?.regime && <RegimeChip regime={j.entryContext.regime} />}
                    <GradeBadge grade={j.entryContext?.quality} />
                    <span className={`mono bold ${tone(j.pnlPct)}`}>{fmtUsd(j.pnl)} ({fmtPct(j.pnlPct)})</span>
                  </div>
                </div>
                <div className="grid g-3" style={{ gap: 14, marginTop: 12 }}>
                  <div className="kv">
                    <span>Entry → exit</span><span>{fmtPrice(j.entryPrice)} → {fmtPrice(j.exitPrice)}</span>
                    <span>Result</span><span className={tone(j.resultR)}>{j.resultR > 0 ? '+' : ''}{j.resultR}R</span>
                    <span>Best / worst during trade</span><span>+{j.mfeR}R / -{j.maeR}R</span>
                    <span>Entry probability</span><span>{j.entryContext?.probability ? `${(j.entryContext.probability * 100).toFixed(0)}%` : '—'}</span>
                  </div>
                  <div className="check-list">
                    {j.checks.map((c) => <span key={c.key} className="row" style={{ gap: 6 }}>{c.ok ? <CheckCircle2 size={13} className="up" /> : <XCircle size={13} className="down" />}{c.text}</span>)}
                  </div>
                  <div className="col" style={{ gap: 8 }}>
                    <div className="insight small"><b>AI recommendation:</b> {j.recommendation}</div>
                    {j.aiReview && <div className="ai-reason small"><b className="row" style={{ gap: 6, marginBottom: 4 }}><Sparkles size={13} color="#b3a1ff" /> Claude coach</b>{j.aiReview}</div>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : <Empty icon={NotebookPen} title="No closed bot trades yet">Every bot trade is analysed here when it closes: what went right, what went wrong, and the rule to apply next time.</Empty>}
      </div>
    </>
  );
}
