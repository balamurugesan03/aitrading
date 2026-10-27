import { useEffect, useState } from 'react';
import { ShieldCheck, Brain, Bot, LineChart } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { Field, Spinner } from '../components/ui.jsx';

// Forgot password: a 6-digit code is sent to the owner's Telegram (when Telegram alerts are connected).
// Without Telegram, the offline reset is changing ADMIN_PASSWORD in server/.env and restarting.
function ResetPassword({ initialUsername, onDone, onCancel }) {
  const [f, setF] = useState({ username: initialUsername || '', code: '', totp: '', password: '', confirm: '' });
  const [sent, setSent] = useState(null); // null | { needs2fa }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const request = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try { setSent(await api.post('/auth/forgot', { username: f.username })); } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };
  const reset = async (e) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setErr('The two passwords do not match');
    setBusy(true);
    setErr('');
    try { onDone(await api.post('/auth/reset', { username: f.username, code: f.code, totp: f.totp || undefined, password: f.password })); } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };

  return (
    <form className="card auth-card" onSubmit={sent ? reset : request}>
      <div className="bold" style={{ fontSize: 18, marginBottom: 18 }}>Reset password</div>
      <div className="col" style={{ gap: 14 }}>
        <Field label="Username"><input className="input" required value={f.username} onChange={set('username')} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={Boolean(sent)} /></Field>
        {!sent ? (
          <div className="small muted">We send a 6-digit reset code to the Telegram chat connected under Account → Telegram. No Telegram? Change <code>ADMIN_PASSWORD</code> in <code>server/.env</code> and restart the server - that resets the password.</div>
        ) : (
          <>
            <div className="alert info small">If Telegram alerts are connected for this account, a code is on its way. It is valid for 10 minutes.</div>
            <Field label="Reset code"><input className="input mono" inputMode="numeric" required autoFocus maxLength={6} value={f.code} onChange={set('code')} style={{ letterSpacing: '0.4em', fontSize: 18 }} /></Field>
            {sent.needs2fa && <Field label="Authenticator code" hint="2FA is on, so the reset also needs it"><input className="input mono" inputMode="numeric" required maxLength={6} value={f.totp} onChange={set('totp')} /></Field>}
            <Field label="New password" hint="At least 8 characters"><input className="input" type="password" required minLength={8} value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
            <Field label="Confirm new password"><input className="input" type="password" required minLength={8} value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></Field>
          </>
        )}
        {err && <div className="alert error">{err}</div>}
        <button className="btn primary block" disabled={busy}>{busy ? <Spinner /> : null}{sent ? 'Set new password' : 'Send reset code'}</button>
        <button type="button" className="btn ghost block" onClick={onCancel}>Back to sign in</button>
      </div>
    </form>
  );
}

export default function Auth() {
  const { login, branding } = useApp();
  const [f, setF] = useState({ name: '', username: '', password: '', confirm: '', code: '' });
  const [need2fa, setNeed2fa] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [signup, setSignup] = useState(false);
  const [signupAllowed, setSignupAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const switchMode = (toSignup) => { setErr(''); setNeed2fa(false); setSignup(toSignup); };

  useEffect(() => { api.get('/auth/options').then((o) => setSignupAllowed(Boolean(o?.signup))).catch(() => {}); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (signup && f.password !== f.confirm) return setErr('The two passwords do not match');
    setBusy(true);
    setErr('');
    try {
      if (signup) {
        login(await api.post('/auth/register', { name: f.name, username: f.username, password: f.password }));
        return;
      }
      const r = await api.post('/auth/login', { username: f.username, password: f.password, code: need2fa ? f.code : undefined });
      if (r.twoFactorRequired) setNeed2fa(true);
      else login(r);
    } catch (ex) {
      setErr(ex.message);
    }
    setBusy(false);
  };

  return (
    <div className="auth-wrap">
      <div className="auth-hero">
        <div className="brand" style={{ padding: 0 }}>
          <img className="brand-img" src="/logo.png" alt={branding.appName} style={{ width: 72, height: 72 }} />
          <div><div className="brand-name" style={{ fontSize: 20 }}>{branding.appName}</div><div className="brand-sub">{branding.tagline}</div></div>
        </div>
        <h2 style={{ fontSize: 34, lineHeight: 1.15, margin: '34px 0 14px' }}>AI trading that <span className="grad-text">manages risk first</span>.</h2>
        <p className="muted" style={{ fontSize: 15, maxWidth: 460 }}>Regime-aware AI signals, a dynamic risk engine, honest out-of-sample backtests and autonomous bots across Binance, Bybit and more.</p>
        <div className="col" style={{ gap: 14, marginTop: 28 }}>
          {[[Brain, '7-model AI ensemble with calibrated probabilities'], [ShieldCheck, 'Dynamic risk engine, kill switch, 2FA, encrypted API keys'], [Bot, 'Autonomous bots with paper and live modes'], [LineChart, 'Walk-forward + Monte Carlo backtesting']].map(([Icon, t]) => (
            <div key={t} className="row" style={{ gap: 12 }}><span className="stat-icon" style={{ position: 'static' }}><Icon size={17} /></span><span>{t}</span></div>
          ))}
        </div>
      </div>
      {forgot ? <ResetPassword initialUsername={f.username} onDone={login} onCancel={() => setForgot(false)} /> : (
      <form className="card auth-card" onSubmit={submit}>
        <div className="bold" style={{ fontSize: 18, marginBottom: 18 }}>{signup ? 'Create account' : 'Sign in'}</div>
        <div className="col" style={{ gap: 14 }}>
          {signup && <Field label="Name"><input className="input" value={f.name} onChange={set('name')} autoComplete="name" maxLength={60} /></Field>}
          <Field label="Username" hint={signup ? '3-60 characters: letters, numbers, . _ @ + -' : undefined}><input className="input" required autoFocus value={f.username} onChange={set('username')} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={need2fa} /></Field>
          <Field label="Password" hint={signup ? 'At least 8 characters' : undefined}><input className="input" type="password" required minLength={signup ? 8 : undefined} value={f.password} onChange={set('password')} autoComplete={signup ? 'new-password' : 'current-password'} disabled={need2fa} /></Field>
          {signup && <Field label="Confirm password"><input className="input" type="password" required minLength={8} value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></Field>}
          {need2fa && (
            <Field label="Authenticator code" hint="6 digits from Google Authenticator / Authy">
              <input className="input mono" inputMode="numeric" autoFocus maxLength={6} value={f.code} onChange={set('code')} style={{ letterSpacing: '0.4em', fontSize: 18 }} />
            </Field>
          )}
          {err && <div className="alert error">{err}</div>}
          <button className="btn primary block" disabled={busy}>{busy ? <Spinner /> : null}{signup ? 'Create account' : need2fa ? 'Verify & sign in' : 'Sign in'}</button>
          {!signup && <button type="button" className="btn ghost block small" onClick={() => { setErr(''); setForgot(true); }}>Forgot password?</button>}
          {signupAllowed && (signup
            ? <button type="button" className="btn ghost block small" onClick={() => switchMode(false)}>Already have an account? Sign in</button>
            : <button type="button" className="btn ghost block small" onClick={() => switchMode(true)}>New here? Create an account</button>)}
          {branding.poweredBy && <div className="tiny dim" style={{ textAlign: 'center' }}>Powered by VelocityX · Not financial advice</div>}
        </div>
      </form>
      )}
    </div>
  );
}
