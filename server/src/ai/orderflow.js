// Order Flow AI: reads the live order book and recent trades to measure who is in control.
import { ex } from '../exchange/index.js';
import { clamp } from './technical.js';

const lastWalls = new Map(); // symbol -> { time, walls } for spoofing detection
const sum = (arr) => arr.reduce((s, x) => s + x, 0);

function findWalls(levels, side, mid) {
  const notional = levels.map(([p, q]) => p * q);
  const mean = sum(notional) / notional.length;
  const sd = Math.sqrt(sum(notional.map((v) => (v - mean) ** 2)) / notional.length);
  return levels
    .map(([p, q], k) => ({ side, price: p, usd: notional[k], distPct: ((p - mid) / mid) * 100 }))
    .filter((w) => w.usd > mean + 3 * sd && w.usd > 50000)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 5);
}

export async function analyzeOrderFlow(symbol, exchange = 'binance') {
  const adapter = ex(exchange);
  const [book, trades] = await Promise.all([adapter.getOrderBook(symbol, 500), adapter.getTrades(symbol, 1000).catch(() => [])]);
  const bestBid = book.bids[0][0];
  const bestAsk = book.asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10000;

  const depthWithin = (levels, pct) => sum(levels.filter(([p]) => Math.abs(p - mid) / mid <= pct / 100).map(([p, q]) => p * q));
  const bid05 = depthWithin(book.bids, 0.5);
  const ask05 = depthWithin(book.asks, 0.5);
  const bid1 = depthWithin(book.bids, 1);
  const ask1 = depthWithin(book.asks, 1);
  const imbalance = bid1 + ask1 ? bid1 / (bid1 + ask1) : 0.5;

  const buyUsd = sum(trades.filter((t) => !t.sellAggressor).map((t) => t.price * t.qty));
  const sellUsd = sum(trades.filter((t) => t.sellAggressor).map((t) => t.price * t.qty));
  const buyPressure = buyUsd + sellUsd ? buyUsd / (buyUsd + sellUsd) : 0.5;
  const delta = buyUsd - sellUsd;
  const tradePriceChange = trades.length ? ((trades.at(-1).price - trades[0].price) / trades[0].price) * 100 : 0;
  const windowSec = trades.length ? (trades.at(-1).time - trades[0].time) / 1000 : 0;

  // Large single prints (top 1% by size)
  const sizes = trades.map((t) => t.price * t.qty).sort((a, b) => a - b);
  const bigCut = sizes[Math.floor(sizes.length * 0.99)] || Infinity;
  const largeTrades = trades.filter((t) => t.price * t.qty >= bigCut && t.price * t.qty > 25000);
  const largeBuys = sum(largeTrades.filter((t) => !t.sellAggressor).map((t) => t.price * t.qty));
  const largeSells = sum(largeTrades.filter((t) => t.sellAggressor).map((t) => t.price * t.qty));

  const walls = [...findWalls(book.bids, 'bid', mid), ...findWalls(book.asks, 'ask', mid)];
  const liquidityZones = walls.map((w) => ({ ...w, usd: Math.round(w.usd), distPct: +w.distPct.toFixed(3) }));

  // Absorption: heavy aggression on one side without price giving way.
  let absorption = null;
  if (sellUsd > buyUsd * 1.5 && tradePriceChange >= -0.02) absorption = { side: 'bullish', text: 'Heavy selling absorbed by bids - price held' };
  if (buyUsd > sellUsd * 1.5 && tradePriceChange <= 0.02) absorption = { side: 'bearish', text: 'Heavy buying absorbed by offers - price capped' };

  // Spoofing heuristic: large walls that vanished since the last snapshot while price never reached them.
  const wallKey = `${exchange}:${symbol}`;
  const prev = lastWalls.get(wallKey);
  const spoofSuspects = [];
  if (prev && Date.now() - prev.time < 5 * 60 * 1000) {
    for (const w of prev.walls) {
      const stillThere = walls.some((x) => x.side === w.side && Math.abs(x.price - w.price) / w.price < 0.0005);
      const reached = w.side === 'bid' ? bestBid <= w.price : bestAsk >= w.price;
      if (!stillThere && !reached && Math.abs(w.distPct) < 1) spoofSuspects.push({ side: w.side, price: w.price, usd: Math.round(w.usd) });
    }
  }
  lastWalls.set(wallKey, { time: Date.now(), walls });

  const liquidity = bid1 + ask1 > 5e6 ? 'High' : bid1 + ask1 > 5e5 ? 'Medium' : 'Low';
  let score = (imbalance - 0.5) * 120 + (buyPressure - 0.5) * 120;
  if (absorption) score += absorption.side === 'bullish' ? 20 : -20;
  if (largeBuys + largeSells > 0) score += ((largeBuys - largeSells) / (largeBuys + largeSells)) * 15;
  if (spoofSuspects.length) score *= 0.7; // fake liquidity lowers trust in the book
  score = clamp(score);

  const notes = [];
  notes.push(`Buy pressure ${(buyPressure * 100).toFixed(0)}% over the last ${trades.length} trades (${windowSec.toFixed(0)}s)`);
  notes.push(`Book imbalance ${(imbalance * 100).toFixed(0)}% bids within 1%`);
  if (absorption) notes.push(absorption.text);
  if (spoofSuspects.length) notes.push(`${spoofSuspects.length} large wall(s) pulled before price reached them (possible spoofing)`);

  return {
    symbol, exchange, time: Date.now(), score,
    bias: score > 15 ? 'Bullish' : score < -15 ? 'Bearish' : 'Neutral',
    buyPressure: +(buyPressure * 100).toFixed(1),
    sellPressure: +((1 - buyPressure) * 100).toFixed(1),
    imbalance: +(imbalance * 100).toFixed(1),
    spreadBps: +spreadBps.toFixed(2),
    depth: { bid05: Math.round(bid05), ask05: Math.round(ask05), bid1: Math.round(bid1), ask1: Math.round(ask1) },
    volumeDeltaUsd: Math.round(delta),
    largeTrades: { count: largeTrades.length, buysUsd: Math.round(largeBuys), sellsUsd: Math.round(largeSells) },
    liquidity, liquidityZones, absorption, spoofSuspects, notes,
  };
}
