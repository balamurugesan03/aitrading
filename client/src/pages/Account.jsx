import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Crown, UserCircle, KeyRound, ShieldCheck, Link2, Send, Code2, ScrollText, Trash2, PlugZap, Copy } from 'lucide-react';
import { api, setToken } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll } from '../lib/hooks.js';
import { Field, Spinner, Switch, Empty, Tabs } from '../components/ui.jsx';
import { fmtTime, ago } from '../lib/format.js';

function Profile() {
  const { user, refreshMe, toast } = useApp();
  const [f, setF] = useState({ name: user?.name || '', displayName: user?.displayName || '', current: '', next: '', confirm: '' });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    try { await api.patch('/auth/profile', { name: f.name, displayName: f.displayName }); refreshMe(); toast('Profile saved'); } catch (e) { toast(e.message, 'err'); }
  };
  const changePw = async () => {
    if (f.next !== f.confirm) return toast('The two new passwords do not match', 'err');
    try { const s = await api.post('/auth/password', { current: f.current, next: f.next }); setToken(s.token); setF((x) => ({ ...x, current: '', next: '', confirm: '' })); toast('Password changed - other sessions signed out'); } catch (e) { toast(e.message, 'err'); }
  };
  const logoutAll = async () => {
    try { const s = await api.post('/auth/logout-all'); setToken(s.token); toast('Signed out on all other devices'); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <div className="grid g-2">
      <div className="card col" style={{ gap: 12 }}>
        <div className="card-title"><UserCircle size={14} /> Profile</div>
        <Field label="Username" hint="Change it with ADMIN_USERNAME in server/.env"><input className="input" value={user?.email || ''} disabled /></Field>
        <Field label="Name"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Public display name" hint="Shown on the copy-trading leaderboard and marketplace"><input className="input" value={f.displayName} onChange={set('displayName')} /></Field>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={save}>Save profile</button>
      </div>
      <div className="card col" style={{ gap: 12 }}>
        <div className="card-title"><KeyRound size={14} /> Password &amp; sessions</div>
        <Field label="Current password"><input className="input" type="password" value={f.current} onChange={set('current')} autoComplete="current-password" /></Field>
        <Field label="New password" hint="At least 8 characters"><input className="input" type="password" value={f.next} onChange={set('next')} autoComplete="new-password" /></Field>
        <Field label="Confirm new password"><input className="input" type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></Field>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" onClick={changePw} disabled={!f.current || f.next.length < 8 || !f.confirm}>Change password</button>
          <button className="btn" onClick={logoutAll}>Sign out other devices</button>
        </div>
        <div className="tiny dim">Forgot it? Use "Forgot password" on the sign-in page (code via Telegram), or change <code>ADMIN_PASSWORD</code> in <code>server/.env</code> and restart.</div>
      </div>
    </div>
  );
}

function TwoFactor() {
  const { user, refreshMe, toast } = useApp();
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const start = async () => {
    const s = await api.post('/auth/2fa/setup');
    setSetup(s);
    setQr(await QRCode.toDataURL(s.otpauth, { margin: 1, width: 200, color: { dark: '#06080d', light: '#ffffff' } }));
  };
  const enable = async () => {
    try { await api.post('/auth/2fa/enable', { code }); setSetup(null); setCode(''); refreshMe(); toast('2FA enabled'); } catch (e) { toast(e.message, 'err'); }
  };
  const disable = async () => {
    try { await api.post('/auth/2fa/disable', { code }); setCode(''); refreshMe(); toast('2FA disabled', 'err'); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <div className="card col" style={{ gap: 12, maxWidth: 640 }}>
      <div className="card-title"><ShieldCheck size={14} /> Two-factor authentication</div>
      {user?.twoFactor ? (
        <>
          <div className="alert info">2FA is <b>enabled</b>. Sign-ins need a code from your authenticator app.</div>
          <Field label="Code to disable"><input className="input mono" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={disable} disabled={code.length !== 6}>Disable 2FA</button>
        </>
      ) : setup ? (
        <div className="row wrap" style={{ gap: 20, alignItems: 'flex-start' }}>
          {qr && <img src={qr} alt="2FA QR code" width={200} height={200} style={{ borderRadius: 10 }} />}
          <div className="col" style={{ gap: 10, flex: 1, minWidth: 220 }}>
            <div className="small muted">Scan with Google Authenticator, Authy or 1Password, or enter this key:</div>
            <div className="code-block" style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{setup.secret}</div>
            <Field label="6-digit code"><input className="input mono" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value)} style={{ letterSpacing: '0.3em' }} /></Field>
            <button className="btn primary" onClick={enable} disabled={code.length !== 6}>Verify &amp; enable</button>
          </div>
        </div>
      ) : (
        <>
          <div className="small muted">Protect your account and exchange keys with a time-based one-time code.</div>
          <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={start}>Set up 2FA</button>
        </>
      )}
    </div>
  );
}

// Zerodha Kite Connect: one login per day (Kite access tokens end at 6:00 AM IST).
function ZerodhaCard({ onChange }) {
  const { toast } = useApp();
  const [s, , reload] = usePoll('/brokers/zerodha/status', 60000);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('zerodha') === 'ok') toast('Zerodha connected - Kite session active until 6:00 AM IST tomorrow');
    if (q.get('zerodha') === 'error') toast(q.get('msg') || 'Zerodha login failed', 'err');
    if (q.get('zerodha')) history.replaceState(null, '', '/account?tab=connections');
  }, [toast]);
  if (!s?.connected) return null;
  const login = async () => {
    setBusy(true);
    try { location.href = (await api.post('/brokers/zerodha/login')).url; } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  const logout = async () => { await api.post('/brokers/zerodha/logout').catch(() => {}); reload(); onChange?.(); };
  return (
    <div className="card col" style={{ gap: 10, gridColumn: '1 / -1' }}>
      <div className="row between">
        <span className="card-title">Zerodha Kite (NSE stocks + forex: USDINR, EURINR, GBPINR, JPYINR)</span>
        <span className={`badge ${s.loggedIn ? 'up' : 'down'}`}>{s.loggedIn ? `Logged in · ${s.kiteUserId}` : 'Not logged in today'}</span>
      </div>
      <div className="small muted">
        {s.loggedIn
          ? <>Session active since {fmtTime(s.sessionAt)}; it ends at 6:00 AM IST. Market {s.marketOpen ? <span className="up">open</span> : <span className="dim">closed</span>} (Mon-Fri 09:00-17:00 IST).</>
          : <>Kite sessions end every morning at 6:00 AM IST. Log in once a day so stock and forex charts, paper trading and bots can run.</>}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" onClick={login} disabled={busy}>{busy ? <Spinner /> : null}{s.loggedIn ? 'Log in again' : 'Log in to Kite'}</button>
        {s.loggedIn && <button className="btn" onClick={logout}>Log out</button>}
      </div>
      <div className="tiny dim">One-time setup: in the Kite developer console, set your app's Redirect URL to <code>{s.redirectUrl}</code></div>
    </div>
  );
}

function Connections() {
  const { toast } = useApp();
  const [conns, , reload] = usePoll('/account/connections');
  const [exchanges] = usePoll('/account/exchanges');
  const [f, setF] = useState({ exchange: 'binance', apiKey: '', apiSecret: '', passphrase: '', testnet: true, label: '' });
  const [busy, setBusy] = useState(null);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  const add = async () => {
    setBusy('add');
    try { await api.post('/account/connections', f); setF((s) => ({ ...s, apiKey: '', apiSecret: '', passphrase: '' })); reload(); toast('Connection saved (encrypted)'); } catch (e) { toast(e.message, 'err'); }
    setBusy(null);
  };
  const test = async (id) => {
    setBusy(id);
    try { const c = await api.post(`/account/connections/${id}/test`); toast(c.lastTestMsg, c.lastTestOk ? 'ok' : 'err'); reload(); } catch (e) { toast(e.message, 'err'); }
    setBusy(null);
  };
  const del = async (id) => { if (confirm('Remove this connection?')) { await api.del(`/account/connections/${id}`); reload(); } };
  return (
    <div className="grid g-wide">
      <ZerodhaCard onChange={reload} />
      <div className="card">
        <div className="card-head"><span className="card-title"><Link2 size={14} /> Exchange API connections</span></div>
        {conns?.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Exchange</th><th>Label</th><th>Key</th><th>Network</th><th>Last test</th><th /></tr></thead>
            <tbody>{conns.map((c) => (
              <tr key={c._id} style={{ opacity: c.active ? 1 : 0.5 }}>
                <td className="bold">{c.exchange}</td><td>{c.label}</td><td className="mono small">{c.apiKey}</td>
                <td><span className={`badge ${c.testnet ? 'accent' : 'down'}`}>{c.exchange === 'zerodha' ? 'NSE' : c.testnet ? 'TESTNET' : 'LIVE'}</span>{!c.active && <span className="tiny dim"> replaced</span>}</td>
                <td className="small">{c.lastTestAt ? <span className={c.lastTestOk ? 'up' : 'down'} title={c.lastTestMsg}>{c.lastTestOk ? 'OK' : 'Failed'} · {ago(c.lastTestAt)}</span> : <span className="dim">never</span>}</td>
                <td><div className="row" style={{ gap: 4 }}><button className="btn sm" onClick={() => test(c._id)} disabled={busy === c._id}>{busy === c._id ? <Spinner size={12} /> : <PlugZap size={12} />} Test</button><button className="btn sm ghost danger" onClick={() => del(c._id)}><Trash2 size={12} /></button></div></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon={Link2} title="No exchanges connected">Paper trading works without keys. Connect an exchange to trade live.</Empty>}
      </div>
      <div className="card col" style={{ gap: 12 }}>
        <div className="card-title">Add connection</div>
        <Field label="Exchange">
          <select className="select" value={f.exchange} onChange={set('exchange')}>
            {(exchanges || []).filter((e) => e.trading && !e.connection).map((e) => <option key={e.id} value={e.id}>{e.id === 'zerodha' ? 'Zerodha Kite (NSE forex, stocks, futures)' : e.id === 'bperp' ? 'Binance USD-M futures (own keys: futures testnet keys differ from spot)' : e.name}</option>)}
          </select>
        </Field>
        {f.exchange === 'zerodha' && <div className="alert info small">Create a Kite Connect app at developers.kite.trade and paste its <b>API key</b> and <b>API secret</b>. After saving, click "Log in to Kite" above. Indian residents may trade only INR currency pairs on NSE.</div>}
        <Field label="API key"><input className="input mono" value={f.apiKey} onChange={set('apiKey')} autoComplete="off" /></Field>
        <Field label="API secret"><input className="input mono" type="password" value={f.apiSecret} onChange={set('apiSecret')} autoComplete="off" /></Field>
        {f.exchange === 'okx' && <Field label="Passphrase"><input className="input mono" type="password" value={f.passphrase} onChange={set('passphrase')} /></Field>}
        {f.exchange !== 'zerodha' && <div className="row between"><span className="small">Testnet / demo account</span><Switch checked={f.testnet} onChange={set('testnet')} /></div>}
        <button className="btn primary" onClick={add} disabled={busy === 'add' || !f.apiKey || !f.apiSecret}>{busy === 'add' ? <Spinner /> : null} Save connection</button>
        {f.exchange !== 'zerodha' && <div className="alert warn small">Create keys with <b>Spot trading only</b>, <b>withdrawals disabled</b> and an IP whitelist. Secrets are encrypted with AES-256-GCM and never shown again.</div>}
      </div>
    </div>
  );
}

function Telegram() {
  const { user, refreshMe, toast } = useApp();
  const [f, setF] = useState({ token: '', chatId: user?.telegram?.chatId || '', enabled: user?.telegram?.enabled ?? true, allEvents: false });
  const save = async () => { try { await api.put('/account/telegram', f); refreshMe(); toast('Telegram settings saved'); } catch (e) { toast(e.message, 'err'); } };
  const test = async () => { try { await api.post('/account/telegram/test'); toast('Test message sent'); } catch (e) { toast(e.message, 'err'); } };
  return (
    <div className="card col" style={{ gap: 12, maxWidth: 640 }}>
      <div className="card-title"><Send size={14} /> Telegram alerts</div>
      <div className="small muted">Get trade fills, stop-outs, kill-switch and payment alerts on your phone. Create a bot with @BotFather, then message it once and get your chat ID from @userinfobot.</div>
      <Field label="Bot token" hint={user?.telegram?.hasToken ? 'A token is saved - leave empty to keep it' : ''}><input className="input mono" type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} /></Field>
      <Field label="Chat ID"><input className="input mono" value={f.chatId} onChange={(e) => setF({ ...f, chatId: e.target.value })} /></Field>
      <div className="row between"><span className="small">Enabled</span><Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} /></div>
      <div className="row between"><span className="small">Send every event (not only important ones)</span><Switch checked={f.allEvents} onChange={(v) => setF({ ...f, allEvents: v })} /></div>
      <div className="row" style={{ gap: 8 }}><button className="btn primary" onClick={save}>Save</button><button className="btn" onClick={test} disabled={!user?.telegram?.hasToken}>Send test</button></div>
    </div>
  );
}

function ApiKeys() {
  const { toast } = useApp();
  const [keys, , reload] = usePoll('/account/apikeys');
  const [name, setName] = useState('My script');
  const [trade, setTrade] = useState(false);
  const [fresh, setFresh] = useState(null);
  const create = async () => {
    try { const k = await api.post('/account/apikeys', { name, scopes: trade ? ['read', 'trade'] : ['read'] }); setFresh(k.key); reload(); } catch (e) { toast(e.message, 'err'); }
  };
  const revoke = async (id) => { if (confirm('Revoke this key? Scripts using it stop working.')) { await api.del(`/account/apikeys/${id}`); reload(); } };
  return (
    <div className="grid g-wide">
      <div className="card">
        <div className="card-head"><span className="card-title"><Code2 size={14} /> API keys</span><a className="small" href="/api-docs">Developer docs →</a></div>
        {fresh && (
          <div className="alert info" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', marginBottom: 12 }}>
            <b>Copy your new key now - it will not be shown again.</b>
            <div className="row" style={{ gap: 8 }}><div className="code-block" style={{ flex: 1 }}>{fresh}</div><button className="btn sm" onClick={() => { navigator.clipboard.writeText(fresh); toast('Copied'); }}><Copy size={13} /></button></div>
          </div>
        )}
        {keys?.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Created</th><th>Last used</th><th /></tr></thead>
            <tbody>{keys.map((k) => (
              <tr key={k._id} style={{ opacity: k.revoked ? 0.45 : 1 }}>
                <td>{k.name}</td><td className="mono small">{k.prefix}…</td><td>{k.scopes.map((s) => <span key={s} className={`badge ${s === 'trade' ? 'warn' : 'flat'}`} style={{ marginRight: 4 }}>{s}</span>)}</td>
                <td className="small muted">{fmtTime(k.createdAt)}</td><td className="small muted">{k.lastUsedAt ? ago(k.lastUsedAt) : 'never'}</td>
                <td>{k.revoked ? <span className="tiny dim">revoked</span> : <button className="btn sm ghost danger" onClick={() => revoke(k._id)}>Revoke</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon={Code2} title="No API keys" />}
      </div>
      <div className="card col" style={{ gap: 12 }}>
        <div className="card-title">Create key</div>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="row between"><span className="small">Allow trading (bots, orders)</span><Switch checked={trade} onChange={setTrade} /></div>
        <button className="btn primary" onClick={create}>Create API key</button>
      </div>
    </div>
  );
}

function AuditLog() {
  const [rows] = usePoll('/account/audit');
  return (
    <div className="card">
      <div className="card-head"><span className="card-title"><ScrollText size={14} /> Security & activity log</span></div>
      {rows?.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Action</th><th>Details</th><th>Via</th><th>IP</th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a._id}><td className="small muted">{fmtTime(a.time)}</td><td className={`small bold ${a.action.includes('failed') ? 'down' : ''}`}>{a.action}</td><td className="small muted" style={{ whiteSpace: 'normal', maxWidth: 380 }}>{JSON.stringify(a.details)}</td><td className="small">{a.via}</td><td className="small mono dim">{a.ip || '—'}</td></tr>
          ))}</tbody>
        </table></div>
      ) : <Empty title="No activity" />}
    </div>
  );
}

const planPrice = (p) => (p.price ? `${p.currency === 'INR' ? '₹' : p.currency === 'USD' ? '$' : `${p.currency} `}${Number(p.price).toLocaleString('en-IN')} / ${p.interval}` : 'Free');

function Subscription() {
  const { toast } = useApp();
  const [s, , reload] = usePoll('/account/subscription');
  if (!s) return <div className="empty"><Spinner /></div>;
  const request = async (p) => {
    if (!confirm(`Request an upgrade to ${p.name} (${planPrice(p)})? The admin activates it once payment is confirmed.`)) return;
    try { await api.post('/account/subscription/request', { planId: p._id }); toast('Request sent - you will be notified when it is approved'); reload(); } catch (e) { toast(e.message, 'err'); }
  };
  const withdraw = async () => { try { await api.del('/account/subscription/request'); toast('Request withdrawn'); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <>
      <div className="card col" style={{ gap: 10, marginBottom: 18 }}>
        <div className="card-title"><Crown size={14} /> Your plan</div>
        <div className="row" style={{ gap: 12, alignItems: 'baseline' }}>
          <span className="bold" style={{ fontSize: 22 }}>{s.plan?.name}</span>
          <span className="muted">{planPrice(s.plan)}</span>
          {s.subscription?.endAt && <span className="badge up">valid until {new Date(s.subscription.endAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>}
        </div>
        {s.exempt
          ? <div className="small muted">You are the platform owner - plan limits do not apply to your account.</div>
          : <div className="small muted">Bots used: {s.usage.bots} / {s.plan?.features?.maxBots ?? 0}</div>}
        {s.pending && (
          <div className="alert info small row between">
            <span>Upgrade to <b>{s.pending.planName}</b> requested - waiting for admin approval.</span>
            <button className="btn small" onClick={withdraw}>Withdraw</button>
          </div>
        )}
      </div>
      <div className="grid g-3">
        {s.plans.map((p) => {
          const current = p._id === s.plan?._id;
          return (
            <div key={p._id} className="card col" style={{ gap: 10, borderColor: current ? 'var(--accent)' : undefined }}>
              <div className="row between"><span className="bold" style={{ fontSize: 17 }}>{p.name}</span>{current && <span className="badge accent">current</span>}</div>
              <div className="stat-value" style={{ fontSize: 22 }}>{planPrice(p)}</div>
              {p.description && <div className="small muted">{p.description}</div>}
              <div className="kv">
                {Object.entries(s.features).map(([k, f]) => [<span key={`${k}l`}>{f.label}</span>, <span key={`${k}v`}>{f.type === 'number' ? p.features?.[k] ?? 0 : p.features?.[k] ? '✓' : '—'}</span>])}
              </div>
              {!current && !s.exempt && p.price > 0 && <button className="btn primary" style={{ marginTop: 'auto' }} disabled={Boolean(s.pending)} onClick={() => request(p)}>Request {p.name}</button>}
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function Account() {
  const [tab, setTab] = useState('profile');
  useEffect(() => { const t = new URLSearchParams(location.search).get('tab'); if (t) setTab(t); }, []);
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'profile', label: 'Profile' }, { value: 'subscription', label: 'Subscription' }, { value: '2fa', label: 'Two-factor auth' }, { value: 'connections', label: 'Exchange connections' },
        { value: 'telegram', label: 'Telegram alerts' }, { value: 'apikeys', label: 'API keys' }, { value: 'audit', label: 'Activity log' },
      ]} />
      {tab === 'profile' && <Profile />}
      {tab === 'subscription' && <Subscription />}
      {tab === '2fa' && <TwoFactor />}
      {tab === 'connections' && <Connections />}
      {tab === 'telegram' && <Telegram />}
      {tab === 'apikeys' && <ApiKeys />}
      {tab === 'audit' && <AuditLog />}
    </>
  );
}
