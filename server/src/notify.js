// Notifications (in-app + optional Telegram) and the audit log.
import { EventEmitter } from 'events';
import { db } from './db/index.js';
import { decrypt } from './auth/crypto.js';

export const notifyEvents = new EventEmitter();

export async function audit(userId, action, details = {}, req = null) {
  return db.audit.insert({
    userId, action, details, time: Date.now(),
    ip: req ? req.ip || req.socket?.remoteAddress || null : null, // req.ip honours TRUST_PROXY; raw X-Forwarded-For is spoofable
    via: req?.apiKey ? `api-key:${req.apiKey.prefix}` : req ? 'web' : 'system',
  });
}

export async function sendTelegram(user, text) {
  const t = user?.telegram;
  if (!t?.enabled || !t.token || !t.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${decrypt(t.token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* never let a notification failure break trading */ }
}

export async function notify(userId, { type = 'info', title, body = '', important = false }) {
  if (!userId) return null;
  const row = await db.notifications.insert({ userId, type, title, body, read: false, time: Date.now() });
  notifyEvents.emit('notification', row);
  const user = await db.users.findOne({ _id: userId });
  if (important || user?.telegram?.allEvents) sendTelegram(user, `<b>${title}</b>\n${body}`);
  return row;
}

export async function testTelegram(user) {
  await sendTelegram({ ...user, telegram: { ...user.telegram, enabled: true } }, '<b>VelocityX</b>\nTelegram alerts are connected.');
}
