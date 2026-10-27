import { useState } from 'react';
import { Users, Trophy, UserPlus, Share2, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll } from '../lib/hooks.js';
import { CoinIcon, Seg, Field, Switch, Spinner, Empty } from '../components/ui.jsx';
import { fmtUsd, fmtPct, fmtPrice, fmtQty, ago, tone, baseOf } from '../lib/format.js';

function FollowModal({ leader, onClose, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState({ mode: 'paper', multiplier: 1, maxTradeUsd: 0 });
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await api.post('/copy/follow', { leaderBotId: leader.botId, ...f }); toast(`Now copying ${leader.name}`); onDone(); onClose(); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ width: 'min(460px,100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 14 }}><b>Copy {leader.name}</b><button className="btn ghost icon-btn" onClick={onClose}><X size={16} /></button></div>
        <div className="col" style={{ gap: 12 }}>
          <Field label="Mode"><Seg className="mode" value={f.mode} onChange={(v) => setF({ ...f, mode: v })} options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} /></Field>
          <Field label="Size multiplier" hint="1 = same % of your equity the leader used. 0.5 = half."><input className="input mono" type="number" step="0.1" min="0.1" max="5" value={f.multiplier} onChange={(e) => setF({ ...f, multiplier: e.target.value })} /></Field>
          <Field label="Max per trade (USDT, 0 = no cap)"><input className="input mono" type="number" value={f.maxTradeUsd} onChange={(e) => setF({ ...f, maxTradeUsd: e.target.value })} /></Field>
          <div className="alert info small">Each copied trade still passes your own kill switch and exposure limit. Past results do not guarantee future returns.</div>
          <button className="btn primary block" onClick={go} disabled={busy}>{busy ? <Spinner /> : <UserPlus size={14} />} Start copying</button>
        </div>
      </div>
    </div>
  );
}

export default function Copy() {
  const { toast } = useApp();
  const [board, , reloadBoard] = usePoll('/copy/leaderboard', 30000);
  const [following, , reloadFollowing] = usePoll('/copy/following', 20000);
  const [bots, , reloadBots] = usePoll('/bots');
  const [follow, setFollow] = useState(null);

  const toggleShare = async (b, copyable) => {
    try { await api.patch(`/copy/bots/${b._id}`, { copyable, copyDescription: b.copyDescription || '' }); reloadBots(); reloadBoard(); toast(copyable ? `${b.name} is now on the leaderboard` : 'Stopped sharing'); } catch (e) { toast(e.message, 'err'); }
  };
  const unfollow = async (l) => {
    const hasPos = l.positions.length > 0;
    if (!confirm(hasPos ? `Unfollow and close ${l.positions.length} copied position(s)?` : 'Unfollow this leader?')) return;
    try { await api.del(`/copy/links/${l._id}${hasPos ? '?closePositions=1' : ''}`); reloadFollowing(); reloadBoard(); } catch (e) { toast(e.message, 'err'); }
  };
  const pauseLink = async (l) => { await api.patch(`/copy/links/${l._id}`, { active: !l.active }); reloadFollowing(); };

  return (
    <>
      <div className="card">
        <div className="card-head"><span className="card-title"><Trophy size={14} /> Leaderboard</span><span className="tiny dim">bots shared by their owners · ranked by total return</span></div>
        {!board ? <Spinner /> : board.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>Bot</th><th>Leader</th><th>Market</th><th className="num">Return</th><th className="num">Win rate</th><th className="num">Trades</th><th className="num">Followers</th><th /></tr></thead>
            <tbody>{board.map((x, k) => (
              <tr key={x.botId}>
                <td className="dim">{k + 1}</td>
                <td><div className="bold small">{x.name}</div><div className="tiny dim">{x.description || x.strategy}</div></td>
                <td className="small">{x.leader}</td>
                <td><div className="coin small"><CoinIcon symbol={x.symbol} size={20} />{baseOf(x.symbol)} · {x.interval} · {x.exchange}</div></td>
                <td className={`num ${tone(x.totalReturnPct)}`}>{fmtPct(x.totalReturnPct)}</td>
                <td className="num">{x.winRate}%</td><td className="num">{x.trades}</td><td className="num">{x.followers}</td>
                <td>{x.own ? <span className="badge flat">Your bot</span> : x.following ? <span className="badge accent">Following</span> : <button className="btn sm primary" onClick={() => setFollow(x)}><UserPlus size={12} /> Copy</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon={Trophy} title="No bots shared yet">Share a bot below to list it here.</Empty>}
      </div>

      <div className="grid g-2">
        <div className="card">
          <div className="card-head"><span className="card-title"><Users size={14} /> Who I copy</span></div>
          {!following ? <Spinner /> : following.length ? (
            <div className="col" style={{ gap: 12 }}>
              {following.map((l) => (
                <div key={l._id} className="position-box" style={{ borderStyle: 'solid' }}>
                  <div className="row between">
                    <div><b>{l.leader?.name || 'Deleted bot'}</b> <span className={`badge ${l.mode === 'live' ? 'down' : 'accent'}`}>{l.mode}</span>{!l.active && <span className="badge warn" style={{ marginLeft: 4 }}>paused</span>}</div>
                    <span className={`mono bold ${tone(l.stats?.pnl)}`}>{fmtUsd(l.stats?.pnl || 0)}</span>
                  </div>
                  <div className="tiny muted" style={{ margin: '4px 0 8px' }}>×{l.multiplier}{l.maxTradeUsd ? ` · max ${fmtUsd(l.maxTradeUsd, 0)}` : ''} · {l.stats?.trades || 0} trades · since {ago(l.createdAt)}</div>
                  {l.positions.map((p) => (
                    <div key={p._id} className="row between small" style={{ marginBottom: 6 }}>
                      <span>{fmtQty(p.qty)} {baseOf(p.symbol)} @ {fmtPrice(p.entry)}</span>
                      <button className="btn sm sell" onClick={async () => { try { await api.post(`/copy/positions/${p._id}/close`); reloadFollowing(); } catch (e) { toast(e.message, 'err'); } }}>Close</button>
                    </div>
                  ))}
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm" onClick={() => pauseLink(l)}>{l.active ? 'Pause' : 'Resume'}</button>
                    <button className="btn sm ghost danger" onClick={() => unfollow(l)}>Unfollow</button>
                  </div>
                </div>
              ))}
            </div>
          ) : <Empty icon={Users} title="You are not copying anyone" />}
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title"><Share2 size={14} /> Share my bots</span></div>
          {bots?.length ? (
            <div className="col" style={{ gap: 10 }}>
              {bots.map((b) => (
                <div key={b._id} className="row between">
                  <div className="coin"><CoinIcon symbol={b.symbol} size={24} /><div><div className="small bold">{b.name}</div><div className="tiny dim">{b.mode} · {b.strategy} · PnL {fmtUsd(b.stats?.pnl || 0)}</div></div></div>
                  <Switch checked={Boolean(b.copyable)} onChange={(v) => toggleShare(b, v)} />
                </div>
              ))}
            </div>
          ) : <Empty title="Create a bot first" />}
        </div>
      </div>
      {follow && <FollowModal leader={follow} onClose={() => setFollow(null)} onDone={() => { reloadFollowing(); reloadBoard(); }} />}
    </>
  );
}
