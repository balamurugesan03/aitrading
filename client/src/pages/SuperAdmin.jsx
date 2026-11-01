// Super Admin panel at /superadmin: separate login and session from the trading app.
// Manages subscription plans, users' subscriptions, upgrade requests, payments and the platform audit log.
import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, Crown, Users, CreditCard, Inbox, Receipt, ScrollText, KeyRound, LogOut, Plus, Pencil, Trash2, Star, CheckCircle2, AlertTriangle, IndianRupee, UserCheck } from 'lucide-react';
import { saApi, setSaToken, getSaToken, saEvents, useSa } from '../lib/saApi.js';
import { Field, Spinner, Switch, Empty, Tabs } from '../components/ui.jsx';
import { fmtTime } from '../lib/format.js';

const money = (v, cur = 'INR') => `${cur === 'INR' ? '₹' : cur === 'USD' ? '$' : `${cur} `}${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const date = (t) => (t ? new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const STATUS_TONE = { active: 'up', trial: 'accent', pending: 'warn', approved: 'up', expired: 'flat', cancelled: 'down', rejected: 'down', withdrawn: 'flat' };

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((msg, kind = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  const view = (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.kind === 'ok' ? <CheckCircle2 size={16} className="up" /> : <AlertTriangle size={16} className="down" />}{t.msg}</div>
      ))}
    </div>
  );
  return [toast, view];
}

function Login() {
  const [f, setF] = useState({ username: '', password: '', code: '' });
  const [need2fa, setNeed2fa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await saApi.post('/auth/login', { username: f.username, password: f.password, code: need2fa ? f.code : undefined });
      if (r.twoFactorRequired) setNeed2fa(true);
      else setSaToken(r.token);
    } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };
  return (
    <div className="auth-wrap">
      <div className="auth-hero">
        <div className="row" style={{ gap: 12 }}><span className="stat-icon violet" style={{ position: 'static' }}><ShieldCheck size={22} /></span><div className="brand-name" style={{ fontSize: 20 }}>Super Admin</div></div>
        <h2 style={{ fontSize: 30, lineHeight: 1.2, margin: '30px 0 12px' }}>Plans, subscriptions &amp; <span className="grad-text">users</span>.</h2>
        <p className="muted" style={{ maxWidth: 440 }}>This is a separate login from the trading app. Trading accounts cannot sign in here, and the Super Admin account cannot sign in to trading.</p>
      </div>
      <form className="card auth-card" onSubmit={submit}>
        <div className="bold" style={{ fontSize: 18, marginBottom: 18 }}>Super Admin sign in</div>
        <div className="col" style={{ gap: 14 }}>
          <Field label="Username"><input className="input" required autoFocus value={f.username} onChange={set('username')} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={need2fa} /></Field>
          <Field label="Password"><input className="input" type="password" required value={f.password} onChange={set('password')} autoComplete="current-password" disabled={need2fa} /></Field>
          {need2fa && <Field label="Authenticator code"><input className="input mono" inputMode="numeric" autoFocus maxLength={6} value={f.code} onChange={set('code')} /></Field>}
          {err && <div className="alert error">{err}</div>}
          <button className="btn primary block" disabled={busy}>{busy && <Spinner />}{need2fa ? 'Verify & sign in' : 'Sign in'}</button>
          <div className="tiny dim" style={{ textAlign: 'center' }}>Forgot the password? Change <code>SUPERADMIN_PASSWORD</code> in <code>server/.env</code> and restart.</div>
          <a className="btn ghost block small" href="/">← Trading app sign in</a>
        </div>
      </form>
    </div>
  );
}

function Overview() {
  const [o] = useSa('/overview', 30000);
  if (!o) return <div className="empty"><Spinner /></div>;
  const Stat = ({ icon: Icon, cls, label, value, sub }) => (
    <div className="card stat"><span className={`stat-icon ${cls}`}><Icon size={18} /></span><span className="stat-label">{label}</span><span className="stat-value">{value}</span><span className="stat-sub muted">{sub}</span></div>
  );
  return (
    <>
      <div className="grid g-4">
        <Stat icon={Users} cls="violet" label="Users" value={o.users.total} sub={`${o.users.newLast30d} new in 30 days · ${o.users.suspended} suspended`} />
        <Stat icon={UserCheck} cls="green" label="Paid subscriptions" value={o.subscriptions.active} sub={`${o.subscriptions.expiringIn7d} expire within 7 days`} />
        <Stat icon={Inbox} cls="warn" label="Pending requests" value={o.subscriptions.pending} sub="Upgrade requests to review" />
        <Stat icon={IndianRupee} cls="green" label="MRR (est.)" value={money(o.revenue.mrr)} sub={`${money(o.revenue.last30d)} last 30d · ${money(o.revenue.total)} total`} />
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head"><span className="card-title"><CreditCard size={14} /> Subscribers by plan</span></div>
        <div className="table-wrap"><table><thead><tr><th>Plan</th><th>Status</th><th className="num">Active subscribers</th></tr></thead>
          <tbody>{o.byPlan.map((p) => <tr key={p._id}><td className="bold">{p.name}</td><td><span className={`badge ${p.active ? 'up' : 'flat'}`}>{p.active ? 'active' : 'inactive'}</span></td><td className="num">{p.subscribers}</td></tr>)}</tbody></table></div>
      </div>
    </>
  );
}

const EMPTY_PLAN = { name: '', code: '', description: '', price: 0, currency: 'INR', interval: 'month', trialDays: 0, active: true, features: { maxBots: 1, liveTrading: false, aiAssistant: false, options: false, copyTrading: false } };

function PlanEditor({ plan, meta, onClose, onSaved, toast }) {
  const [p, setP] = useState(plan || EMPTY_PLAN);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setP((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));
  const setF = (k) => (v) => setP((s) => ({ ...s, features: { ...s.features, [k]: v?.target ? v.target.value : v } }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: p.name, code: p.code, description: p.description, price: Number(p.price), currency: p.currency, interval: p.interval, trialDays: Number(p.trialDays), active: p.active, features: p.features };
      await (plan?._id ? saApi.patch(`/plans/${plan._id}`, body) : saApi.post('/plans', body));
      toast(plan?._id ? 'Plan updated' : 'Plan created');
      onSaved();
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal col" style={{ gap: 12 }} onClick={(e) => e.stopPropagation()}>
        <div className="bold" style={{ fontSize: 17 }}>{plan?._id ? `Edit ${plan.name}` : 'New plan'}</div>
        <div className="grid g-2" style={{ gap: 12 }}>
          <Field label="Name"><input className="input" value={p.name} onChange={set('name')} maxLength={40} /></Field>
          <Field label="Code" hint="Short id, e.g. pro"><input className="input mono" value={p.code} onChange={set('code')} maxLength={30} /></Field>
          <Field label="Price"><input className="input" type="number" min={0} value={p.price} onChange={set('price')} /></Field>
          <Field label="Currency"><select className="input" value={p.currency} onChange={set('currency')}>{['INR', 'USD', 'USDT', 'EUR'].map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Billing period"><select className="input" value={p.interval} onChange={set('interval')}>{(meta?.intervals || ['month', 'quarter', 'year', 'lifetime']).map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Trial days"><input className="input" type="number" min={0} value={p.trialDays} onChange={set('trialDays')} /></Field>
        </div>
        <Field label="Description"><input className="input" value={p.description} onChange={set('description')} maxLength={200} /></Field>
        <div className="card-title" style={{ marginTop: 6 }}>Features &amp; limits</div>
        {Object.entries(meta?.features || {}).map(([k, f]) => (
          <div key={k} className="row between">
            <span className="small">{f.label}</span>
            {f.type === 'number'
              ? <input className="input" type="number" min={0} max={1000} style={{ width: 110 }} value={p.features[k] ?? 0} onChange={setF(k)} />
              : <Switch checked={p.features[k]} onChange={setF(k)} />}
          </div>
        ))}
        <div className="row between"><span className="small">Plan available to users</span><Switch checked={p.active} onChange={set('active')} /></div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !p.name}>{busy && <Spinner />}Save plan</button>
        </div>
      </div>
    </div>
  );
}

function Plans({ toast }) {
  const [data, reload] = useSa('/plans');
  const [editing, setEditing] = useState(null); // null | {} (new) | plan
  if (!data) return <div className="empty"><Spinner /></div>;
  const act = async (fn, msg) => { try { const r = await fn(); toast(r?.deactivated ? 'Plan has subscribers - deactivated instead of deleted' : msg); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <span className="muted small">Users without a paid subscription are on the <b>default</b> plan.</span>
        <button className="btn primary" onClick={() => setEditing({})}><Plus size={15} /> New plan</button>
      </div>
      <div className="grid g-3">
        {data.plans.map((p) => (
          <div key={p._id} className="card col" style={{ gap: 10, opacity: p.active ? 1 : 0.6 }}>
            <div className="row between">
              <span className="bold" style={{ fontSize: 17 }}>{p.name}</span>
              <span className="row" style={{ gap: 6 }}>{p.isDefault && <span className="badge accent">default</span>}{!p.active && <span className="badge flat">inactive</span>}</span>
            </div>
            <div><span className="stat-value" style={{ fontSize: 24 }}>{money(p.price, p.currency)}</span><span className="muted small"> / {p.interval}</span></div>
            {p.description && <div className="small muted">{p.description}</div>}
            <div className="kv">
              {Object.entries(data.features).map(([k, f]) => [<span key={`${k}l`}>{f.label}</span>, <span key={`${k}v`}>{f.type === 'number' ? p.features?.[k] ?? 0 : p.features?.[k] ? '✓' : '—'}</span>])}
              <span>Active subscribers</span><span>{p.subscribers}</span>
            </div>
            <div className="row" style={{ gap: 6, marginTop: 'auto' }}>
              <button className="btn small" onClick={() => setEditing(p)}><Pencil size={13} /> Edit</button>
              {!p.isDefault && <button className="btn small" onClick={() => act(() => saApi.patch(`/plans/${p._id}`, { isDefault: true }), `${p.name} is now the default plan`)}><Star size={13} /> Make default</button>}
              {!p.isDefault && <button className="btn small ghost" onClick={() => confirm(`Delete plan ${p.name}?`) && act(() => saApi.del(`/plans/${p._id}`), 'Plan deleted')}><Trash2 size={13} /></button>}
            </div>
          </div>
        ))}
      </div>
      {editing && <PlanEditor plan={editing._id ? editing : null} meta={data} toast={toast} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function AssignPlan({ user, plans, onClose, onDone, toast }) {
  const paid = plans.filter((p) => p.active);
  const [f, setF] = useState({ planId: paid.find((p) => !p.isDefault)?._id || paid[0]?._id, days: '', amount: '', method: 'manual', note: '' });
  const plan = plans.find((p) => p._id === f.planId);
  useEffect(() => { if (plan) setF((s) => ({ ...s, amount: String(plan.price) })); }, [f.planId]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    try {
      await saApi.post(`/users/${user._id}/subscription`, { planId: f.planId, days: f.days ? Number(f.days) : undefined, amount: Number(f.amount || 0), method: f.method, note: f.note });
      toast(`${user.email} is now on ${plan.name}`);
      onDone();
    } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal col" style={{ gap: 12 }} onClick={(e) => e.stopPropagation()}>
        <div className="bold" style={{ fontSize: 17 }}>Assign plan to {user.email}</div>
        <div className="small muted">Currently: {user.plan?.name}{user.subscription?.endAt ? ` until ${date(user.subscription.endAt)}` : ''}. Assigning the same plan extends it.</div>
        <Field label="Plan"><select className="input" value={f.planId} onChange={set('planId')}>{paid.map((p) => <option key={p._id} value={p._id}>{p.name} — {money(p.price, p.currency)} / {p.interval}</option>)}</select></Field>
        <div className="grid g-2" style={{ gap: 12 }}>
          <Field label="Duration (days)" hint={`Empty = one ${plan?.interval || 'period'}`}><input className="input" type="number" min={1} value={f.days} onChange={set('days')} /></Field>
          <Field label={`Amount received (${plan?.currency || 'INR'})`} hint="0 for a free grant"><input className="input" type="number" min={0} value={f.amount} onChange={set('amount')} /></Field>
          <Field label="Payment method"><select className="input" value={f.method} onChange={set('method')}>{['manual', 'upi', 'bank', 'card', 'cash', 'crypto', 'free'].map((m) => <option key={m}>{m}</option>)}</select></Field>
          <Field label="Note / reference"><input className="input" value={f.note} onChange={set('note')} maxLength={300} /></Field>
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={!f.planId}>Assign plan</button>
        </div>
      </div>
    </div>
  );
}

function UsersTab({ toast }) {
  const [users, reload] = useSa('/users', 30000);
  const [plans] = useSa('/plans');
  const [assign, setAssign] = useState(null);
  const [q, setQ] = useState('');
  if (!users || !plans) return <div className="empty"><Spinner /></div>;
  const act = async (fn, msg) => { try { await fn(); toast(msg); reload(); } catch (e) { toast(e.message, 'err'); } };
  const rows = users.filter((u) => !q || `${u.email} ${u.name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="card">
      <div className="card-head"><span className="card-title"><Users size={14} /> Users ({users.length})</span><input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 220 }} /></div>
      {rows.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Plan</th><th>Valid until</th><th className="num">Bots</th><th>Joined</th><th /></tr></thead>
          <tbody>{rows.map((u) => (
            <tr key={u._id}>
              <td><div className="bold small">{u.email}</div><div className="tiny dim">{u.name}</div></td>
              <td><span className={`badge ${u.role === 'admin' ? 'ai' : 'flat'}`}>{u.role === 'admin' ? 'owner' : 'user'}</span></td>
              <td><span className={`badge ${u.status === 'suspended' ? 'down' : 'up'}`}>{u.status}</span></td>
              <td className="small bold">{u.plan?.name}</td>
              <td className="small">{u.subscription ? date(u.subscription.endAt) : <span className="dim">—</span>}</td>
              <td className="num">{u.bots}</td>
              <td className="small muted">{date(u.createdAt)}</td>
              <td><div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <button className="btn small primary" onClick={() => setAssign(u)}>Assign plan</button>
                {u.subscription && <button className="btn small" onClick={() => confirm(`Cancel ${u.email}'s ${u.plan?.name} subscription?`) && act(() => saApi.post(`/users/${u._id}/subscription/cancel`), 'Subscription cancelled')}>Cancel sub</button>}
                {u.status === 'suspended'
                  ? <button className="btn small" onClick={() => act(() => saApi.patch(`/users/${u._id}`, { status: 'active' }), 'User re-activated')}>Activate</button>
                  : <button className="btn small kill" onClick={() => confirm(`Suspend ${u.email}? Their bots stop and they are signed out.`) && act(() => saApi.patch(`/users/${u._id}`, { status: 'suspended' }), 'User suspended')}>Suspend</button>}
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty title="No users found" />}
      {assign && <AssignPlan user={assign} plans={plans.plans} toast={toast} onClose={() => setAssign(null)} onDone={() => { setAssign(null); reload(); }} />}
    </div>
  );
}

function Requests({ toast }) {
  const [scope, setScope] = useState('pending');
  const [rows, reload] = useSa(scope === 'pending' ? '/subscriptions?status=pending' : '/subscriptions', 30000);
  const act = async (fn, msg) => { try { await fn(); toast(msg); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title"><Inbox size={14} /> {scope === 'pending' ? 'Upgrade requests' : 'All subscriptions'}</span>
        <div className="seg"><button className={scope === 'pending' ? 'on' : ''} onClick={() => setScope('pending')}>Pending</button><button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All</button></div>
      </div>
      {!rows ? <Spinner /> : rows.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>User</th><th>Plan</th><th>Status</th><th>Period</th><th className="num">Amount</th><th>Note</th><th /></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s._id}>
              <td className="small muted">{fmtTime(s.requestedAt || s.createdAt)}</td>
              <td className="small">{s.email || '—'}</td>
              <td className="bold small">{s.planName}</td>
              <td><span className={`badge ${STATUS_TONE[s.status] || 'flat'}`}>{s.status}</span></td>
              <td className="small">{s.startAt ? `${date(s.startAt)} → ${date(s.endAt)}` : '—'}</td>
              <td className="num">{money(s.amount, s.currency)}</td>
              <td className="small muted">{s.rejectReason || s.note || ''}</td>
              <td>{s.status === 'pending' && <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <button className="btn small primary" onClick={() => {
                  const amount = prompt(`Amount received from ${s.email} (${s.currency || 'INR'})`, String(s.amount ?? 0));
                  if (amount !== null) act(() => saApi.post(`/subscriptions/${s._id}/approve`, { amount: Number(amount) || 0 }), 'Approved - plan activated');
                }}>Approve</button>
                <button className="btn small" onClick={() => { const reason = prompt('Reason (shown to the user)', ''); if (reason !== null) act(() => saApi.post(`/subscriptions/${s._id}/reject`, { reason }), 'Request rejected'); }}>Reject</button>
              </div>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty title={scope === 'pending' ? 'No pending requests' : 'No subscriptions yet'} />}
    </div>
  );
}

function SimpleList({ url, title, icon: Icon, cols }) {
  const [rows] = useSa(url, 30000);
  return (
    <div className="card">
      <div className="card-head"><span className="card-title"><Icon size={14} /> {title}</span></div>
      {!rows ? <Spinner /> : rows.length ? (
        <div className="table-wrap"><table>
          <thead><tr>{cols.map(([h, , cls]) => <th key={h} className={cls}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr key={r._id}>{cols.map(([h, f, cls]) => <td key={h} className={cls}>{f(r)}</td>)}</tr>)}</tbody>
        </table></div>
      ) : <Empty title="Nothing here yet" />}
    </div>
  );
}

function AccountTab({ me, toast }) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    if (f.next !== f.confirm) return toast('The two new passwords do not match', 'err');
    try { const s = await saApi.post('/auth/password', { current: f.current, next: f.next }); setSaToken(s.token); setF({ current: '', next: '', confirm: '' }); toast('Password changed'); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <div className="card col" style={{ gap: 12, maxWidth: 480 }}>
      <div className="card-title"><KeyRound size={14} /> Super Admin password</div>
      <Field label="Username" hint="Change it with SUPERADMIN_USERNAME in server/.env"><input className="input" value={me?.email || ''} disabled /></Field>
      <Field label="Current password"><input className="input" type="password" value={f.current} onChange={set('current')} autoComplete="current-password" /></Field>
      <Field label="New password" hint="At least 12 characters"><input className="input" type="password" value={f.next} onChange={set('next')} autoComplete="new-password" /></Field>
      <Field label="Confirm new password"><input className="input" type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></Field>
      <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={save} disabled={!f.current || f.next.length < 12}>Change password</button>
    </div>
  );
}

function Panel({ toast }) {
  const [tab, setTab] = useState('overview');
  const [me, setMe] = useState(null);
  useEffect(() => { saApi.get('/auth/me').then((r) => setMe(r.user)).catch(() => {}); }, []);
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 18px 60px' }}>
      <div className="row between" style={{ marginBottom: 18 }}>
        <div className="row" style={{ gap: 12 }}>
          <span className="stat-icon violet" style={{ position: 'static' }}><ShieldCheck size={20} /></span>
          <div><div className="bold" style={{ fontSize: 18 }}>Super Admin</div><div className="tiny dim">{me?.email}</div></div>
        </div>
        <button className="btn" onClick={() => setSaToken(null)}><LogOut size={15} /> Sign out</button>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'overview', label: 'Overview', icon: Crown }, { value: 'plans', label: 'Plans', icon: CreditCard }, { value: 'users', label: 'Users & subscriptions', icon: Users },
        { value: 'requests', label: 'Requests', icon: Inbox }, { value: 'payments', label: 'Payments', icon: Receipt }, { value: 'audit', label: 'Audit log', icon: ScrollText }, { value: 'account', label: 'Account', icon: KeyRound },
      ]} />
      {tab === 'overview' && <Overview />}
      {tab === 'plans' && <Plans toast={toast} />}
      {tab === 'users' && <UsersTab toast={toast} />}
      {tab === 'requests' && <Requests toast={toast} />}
      {tab === 'payments' && <SimpleList url="/payments" title="Payments" icon={Receipt} cols={[
        ['Date', (p) => fmtTime(p.time), 'small muted'], ['User', (p) => p.email || '—', 'small'], ['Plan', (p) => p.planName, 'small bold'],
        ['Method', (p) => p.method, 'small'], ['Amount', (p) => money(p.amount, p.currency), 'num'], ['Note', (p) => p.note || '', 'small muted'],
      ]} />}
      {tab === 'audit' && <SimpleList url="/audit" title="Audit log (all accounts)" icon={ScrollText} cols={[
        ['Time', (a) => fmtTime(a.time), 'small muted'], ['User', (a) => a.email || '—', 'small'], ['Action', (a) => a.action, 'small bold'],
        ['Details', (a) => JSON.stringify(a.details || {}).slice(0, 120), 'small muted'], ['IP', (a) => a.ip || '—', 'small mono dim'],
      ]} />}
      {tab === 'account' && <AccountTab me={me} toast={toast} />}
    </div>
  );
}

export default function SuperAdmin() {
  const [authed, setAuthed] = useState(Boolean(getSaToken()));
  const [toast, toasts] = useToasts();
  useEffect(() => {
    document.title = 'Super Admin';
    const on = () => setAuthed(Boolean(getSaToken()));
    saEvents.addEventListener('change', on);
    return () => saEvents.removeEventListener('change', on);
  }, []);
  return <>{authed ? <Panel toast={toast} /> : <Login />}{toasts}</>;
}
