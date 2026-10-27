import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Send, User, Trash2, Link2 } from 'lucide-react';
import { streamChat } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { useLocalState } from '../lib/hooks.js';
import { Switch } from '../components/ui.jsx';
import { baseOf } from '../lib/format.js';

const SUGGESTIONS = [
  'Should I buy BTC right now? Give me key levels.',
  'Explain the current AI signal and what is driving it',
  'Design a low-risk strategy for a $1000 account',
  'What does RSI divergence mean and how do I trade it?',
  'ETH ippo buy pannalama? Tamil-la sollu',
];

export default function Assistant() {
  const { symbol, interval, status } = useApp();
  const [messages, setMessages] = useLocalState('nexus.chat', []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [withContext, setWithContext] = useState(true);
  const scroller = useRef(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  const send = async (text) => {
    const msg = (text ?? input).trim();
    if (!msg || busy) return;
    setInput('');
    const history = messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: 'user', content: msg }, { role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    const update = (fn) => setMessages((m) => {
      const copy = [...m];
      copy[copy.length - 1] = fn(copy[copy.length - 1]);
      return copy;
    });
    try {
      await streamChat(
        { history, message: msg, symbol: withContext ? symbol : undefined, interval },
        {
          onText: (t) => update((last) => ({ ...last, content: last.content + t })),
          onError: (e) => update((last) => ({ ...last, content: `⚠️ ${e}`, error: true })),
        },
      );
    } catch (e) {
      update((last) => ({ ...last, content: `⚠️ ${e.message}`, error: true }));
    }
    update((last) => ({ ...last, streaming: false }));
    setBusy(false);
  };

  return (
    <div className="chat">
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="row small" style={{ gap: 10 }}>
          <Switch checked={withContext} onChange={setWithContext} />
          <span className="row" style={{ gap: 6 }}><Link2 size={14} /> Attach live AI analysis of <b>{baseOf(symbol)}/USDT · {interval}</b></span>
        </div>
        {messages.length > 0 && <button className="btn sm ghost" onClick={() => setMessages([])}><Trash2 size={13} /> Clear chat</button>}
      </div>
      {!status?.claude && <div className="alert warn" style={{ marginBottom: 12 }}>Set ANTHROPIC_API_KEY in server/.env and restart the server to enable the Claude AI assistant.</div>}

      <div className="chat-scroll" ref={scroller}>
        {!messages.length && (
          <div className="empty" style={{ marginTop: '8vh' }}>
            <img className="brand-img" src="/logo.png" alt="VelocityX" style={{ width: 72, height: 72 }} />
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>Ask <span className="grad-text">VelocityX AI</span> anything</div>
            <div className="small">Powered by Claude · sees live indicators, neural-net forecast &amp; sentiment</div>
            <div className="suggest" style={{ justifyContent: 'center', maxWidth: 720, marginTop: 10 }}>
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role === 'user' ? 'user' : 'ai'}`}>
            <div className="msg-avatar">{m.role === 'user' ? <User size={16} /> : <img src="/logo.png" alt="" style={{ width: 22, height: 22, objectFit: 'contain' }} />}</div>
            <div className="msg-body">
              {m.role === 'user' ? m.content : <ReactMarkdown>{m.content}</ReactMarkdown>}
              {m.streaming && <span className="cursor" />}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-input">
        <textarea rows={1} value={input} placeholder="Ask about any coin, strategy or indicator…" onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="btn primary" onClick={() => send()} disabled={busy || !input.trim()}><Send size={15} /></button>
      </div>
    </div>
  );
}
