// News Intelligence: crypto RSS feeds -> NLP sentiment -> asset detection -> impact -> risk adjustment.
import crypto from 'crypto';
import { classifyHeadlines } from './claude.js';
import { hasClaude } from '../config.js';

const FEEDS = [
  { source: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { source: 'Decrypt', url: 'https://decrypt.co/feed' },
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
];

const ASSETS = {
  BTC: /\b(bitcoin|btc)\b/i, ETH: /\b(ethereum|ether|eth)\b/i, SOL: /\b(solana|sol)\b/i, BNB: /\b(bnb|binance coin)\b/i,
  XRP: /\b(xrp|ripple)\b/i, DOGE: /\b(dogecoin|doge)\b/i, ADA: /\b(cardano|ada)\b/i, AVAX: /\b(avalanche|avax)\b/i,
  LINK: /\b(chainlink)\b/i, TON: /\b(toncoin|ton)\b/i, DOT: /\b(polkadot)\b/i, TRX: /\b(tron|trx)\b/i,
  LTC: /\b(litecoin|ltc)\b/i, SUI: /\bsui\b/i, PEPE: /\bpepe\b/i, SHIB: /\b(shiba|shib)\b/i,
};
const CATEGORIES = [
  ['etf', /\betfs?\b/i, 'HIGH'], ['regulation', /\b(sec|cftc|regulat\w*|lawsuit|court|ban|bill|senate|congress|mica)\b/i, 'HIGH'],
  ['macro', /\b(fed|fomc|powell|cpi|inflation|rate (cut|hike)|interest rates?|jobs report|recession|tariff)\b/i, 'HIGH'],
  ['security', /\b(hack\w*|exploit\w*|drain\w*|stolen|breach)\b/i, 'HIGH'],
  ['exchange', /\b(binance|coinbase|kraken|okx|bybit|exchange|listing|delist\w*)\b/i, 'MEDIUM'],
  ['adoption', /\b(adopt\w*|partnership|integrat\w*|launch\w*|treasury|reserve)\b/i, 'MEDIUM'],
];
const POS = /\b(surge\w*|soar\w*|rall\w*|record|all-time high|approv\w*|inflows?|bullish|gain\w*|jump\w*|adopt\w*|partnership|upgrade|buy\w*|accumulat\w*|recover\w*)\b/gi;
const NEG = /\b(crash\w*|plunge\w*|drop\w*|fall\w*|slump\w*|hack\w*|exploit\w*|ban\w*|lawsuit|sue[sd]?|outflows?|bearish|liquidat\w*|bankrupt\w*|fraud|delist\w*|reject\w*|sell-?off|dump\w*|fear)\b/gi;

let cache = { at: 0, items: [] };
const classified = new Map(); // headline hash -> analysis

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

async function fetchFeed({ source, url }) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 VelocityX-AI' }, signal: AbortSignal.timeout(8000) });
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 25).map((m) => {
      const tag = (t) => decode(m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`))?.[1] || '');
      return { source, title: tag('title'), link: tag('link'), summary: tag('description').slice(0, 280), time: Date.parse(tag('pubDate')) || Date.now() };
    }).filter((x) => x.title);
  } catch {
    return [];
  }
}

function lexicon(item) {
  const text = `${item.title} ${item.summary}`;
  const pos = (text.match(POS) || []).length;
  const neg = (text.match(NEG) || []).length;
  const sentiment = pos + neg ? Math.round(((pos - neg) / (pos + neg)) * 70) : 0;
  const assets = Object.entries(ASSETS).filter(([, re]) => re.test(text)).map(([a]) => a);
  const cat = CATEGORIES.find(([, re]) => re.test(text));
  return { sentiment, impact: cat ? cat[2] : 'LOW', category: cat ? cat[0] : 'other', assets, method: 'lexicon' };
}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export async function getNews({ force = false } = {}) {
  if (!force && Date.now() - cache.at < 10 * 60 * 1000 && cache.items.length) return cache.items;
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  const seen = new Set();
  const items = all.filter((x) => (seen.has(x.title) ? false : seen.add(x.title))).sort((a, b) => b.time - a.time).slice(0, 60);

  // Claude classifies new headlines in one batch; the lexicon is the fallback.
  const fresh = items.filter((x) => !classified.has(hash(x.title)));
  if (fresh.length && hasClaude()) {
    const result = await classifyHeadlines(fresh.map((x) => `${x.title} - ${x.summary.slice(0, 160)}`));
    if (result) result.forEach((r) => fresh[r.index] && classified.set(hash(fresh[r.index].title), { ...r, method: 'claude' }));
  }
  for (const x of items) {
    const h = hash(x.title);
    if (!classified.has(h)) classified.set(h, lexicon(x));
    Object.assign(x, classified.get(h), { id: h });
    delete x.index;
  }
  cache = { at: Date.now(), items };
  return items;
}

const IMPACT_W = { LOW: 0.3, MEDIUM: 0.6, HIGH: 1 };

// Aggregates the last 24h of news for one asset (or the whole market) with time decay.
export async function newsForAsset(asset) {
  const items = await getNews();
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const relevant = items.filter((x) => x.time >= dayAgo && (asset ? x.assets.includes(asset) || (asset === 'BTC' && x.category === 'macro') : true));
  const marketWide = items.filter((x) => x.time >= dayAgo && (x.category === 'macro' || x.category === 'regulation' || x.category === 'etf'));
  const agg = (rows) => {
    let s = 0;
    let w = 0;
    for (const x of rows) {
      const decay = Math.exp(-(Date.now() - x.time) / (8 * 3600 * 1000));
      const wt = IMPACT_W[x.impact] * decay;
      s += x.sentiment * wt;
      w += wt;
    }
    return w ? Math.round(s / w) : 0;
  };
  const assetScore = agg(relevant);
  const marketScore = agg(marketWide);
  const sentiment = relevant.length ? Math.round(assetScore * 0.7 + marketScore * 0.3) : marketScore;
  const highImpact = [...relevant, ...marketWide].filter((x) => x.impact === 'HIGH');
  const impact = highImpact.length >= 2 || highImpact.some((x) => Math.abs(x.sentiment) >= 60) ? 'HIGH' : relevant.length ? 'MEDIUM' : 'LOW';
  let riskAction = 'none';
  let riskMultiplier = 1;
  if (sentiment <= -75 && impact === 'HIGH') { riskAction = 'block'; riskMultiplier = 0; }
  else if (sentiment <= -50 && impact === 'HIGH') { riskAction = 'reduce'; riskMultiplier = 0.5; }
  else if (sentiment <= -30) { riskAction = 'reduce'; riskMultiplier = 0.75; }
  return {
    asset, sentiment, impact, riskAction, riskMultiplier,
    count: relevant.length, method: hasClaude() ? 'claude' : 'lexicon',
    headlines: relevant.slice(0, 8).map(({ title, link, source, time, sentiment: s, impact: im, category }) => ({ title, link, source, time, sentiment: s, impact: im, category })),
  };
}

// ---- Economic calendar (ForexFactory weekly feed): high-impact USD events cut position size around release ----
let calCache = { at: 0, events: [] };
const CRYPTO_MOVERS = /(CPI|PCE|FOMC|Federal Funds|Fed Chair|Powell|Non-Farm|NFP|Unemployment Rate|GDP|PPI|Retail Sales|Interest Rate)/i;

export async function getCalendar() {
  if (Date.now() - calCache.at < 60 * 60 * 1000 && calCache.events.length) return calCache.events;
  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0 VelocityX-AI' }, signal: AbortSignal.timeout(8000) });
    const rows = await res.json();
    const events = rows
      .filter((e) => ['High', 'Medium'].includes(e.impact) && ['USD', 'EUR', 'CNY', 'JPY', 'GBP'].includes(e.country))
      .map((e) => ({ title: e.title, country: e.country, impact: e.impact, time: Date.parse(e.date), forecast: e.forecast, previous: e.previous, cryptoMover: e.country === 'USD' && CRYPTO_MOVERS.test(e.title) }))
      .sort((a, b) => a.time - b.time);
    calCache = { at: Date.now(), events };
  } catch { /* keep the previous cache */ }
  return calCache.events;
}

// Risk around scheduled macro releases: within 2h before / 1h after a high-impact USD event.
export async function macroEventRisk() {
  const events = await getCalendar();
  const now = Date.now();
  const near = events.filter((e) => e.impact === 'High' && e.country === 'USD' && e.time - now < 2 * 3600e3 && now - e.time < 3600e3);
  const next = events.find((e) => e.impact === 'High' && e.country === 'USD' && e.time > now) || null;
  const major = near.filter((e) => e.cryptoMover);
  return {
    multiplier: major.length ? 0.5 : near.length ? 0.75 : 1,
    active: near.map((e) => ({ title: e.title, time: e.time })),
    next: next && { title: next.title, time: next.time, cryptoMover: next.cryptoMover },
    note: major.length ? `High-impact release: ${major.map((e) => e.title).join(', ')}` : near.length ? `USD event window: ${near.map((e) => e.title).join(', ')}` : next ? `Next high-impact USD event: ${next.title}` : 'No high-impact USD events this week',
  };
}
