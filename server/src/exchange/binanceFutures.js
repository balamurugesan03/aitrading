// Binance USD-M Futures public data (analytics only - VelocityX does not place futures orders).
import WebSocket from 'ws';
import { config } from '../config.js';
import { relayHeaders } from './binance.js';

const FAPI = () => config.binance.relayUrl || 'https://fapi.binance.com';
const FSTREAM = () => (config.binance.relayUrl ? `${config.binance.relayUrl.replace(/^http/, 'ws')}/fws` : 'wss://fstream.binance.com');

async function get(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${FAPI()}${pathname}?${qs}`;
  const res = await fetch(url, { headers: relayHeaders(url), signal: AbortSignal.timeout(10000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.msg || `Futures HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export const getPremiumIndex = (symbol) => get('/fapi/v1/premiumIndex', { symbol });
export const getFundingHistory = (symbol, limit = 30) => get('/fapi/v1/fundingRate', { symbol, limit });
export const getFuturesTicker = (symbol) => get('/fapi/v1/ticker/24hr', { symbol });
export const getOpenInterestHist = (symbol, period = '1h', limit = 48) => get('/futures/data/openInterestHist', { symbol, period, limit });
export const getLongShortRatio = (symbol, period = '1h', limit = 48) => get('/futures/data/globalLongShortAccountRatio', { symbol, period, limit });
export const getTopTraderRatio = (symbol, period = '1h', limit = 24) => get('/futures/data/topLongShortPositionRatio', { symbol, period, limit });
export const getTakerRatio = (symbol, period = '1h', limit = 24) => get('/futures/data/takerlongshortRatio', { symbol, period, limit });

// ---- Liquidation stream (the REST endpoint was retired, so we keep a rolling 24h buffer from the WebSocket) ----
const liquidations = [];
let liqSocket = null;
let liqRetry = null;

export function startLiquidationStream() {
  if (liqSocket) return;
  const connect = () => {
    const wsUrl = `${FSTREAM()}/ws/!forceOrder@arr`;
    liqSocket = new WebSocket(wsUrl, { headers: config.binance.relayUrl ? { 'X-Relay-Key': config.binance.relayKey } : {} });
    liqSocket.on('message', (raw) => {
      try {
        const o = JSON.parse(raw).o;
        liquidations.push({
          symbol: o.s,
          side: o.S === 'SELL' ? 'LONG' : 'SHORT', // a forced SELL liquidates a long
          qty: +o.q,
          price: +o.ap || +o.p,
          usd: (+o.q) * (+o.ap || +o.p),
          time: o.T,
        });
        const cutoff = Date.now() - 24 * 3600 * 1000;
        while (liquidations.length && liquidations[0].time < cutoff) liquidations.shift();
      } catch { /* ignore malformed frames */ }
    });
    const retry = () => {
      liqSocket = null;
      clearTimeout(liqRetry);
      liqRetry = setTimeout(startLiquidationStream, 10000);
    };
    liqSocket.on('close', retry);
    liqSocket.on('error', () => liqSocket?.terminate());
  };
  connect();
}

export function getLiquidations(symbol, sinceMs = 24 * 3600 * 1000) {
  const cutoff = Date.now() - sinceMs;
  const rows = liquidations.filter((l) => l.time >= cutoff && (!symbol || l.symbol === symbol));
  const longs = rows.filter((l) => l.side === 'LONG').reduce((s, l) => s + l.usd, 0);
  const shorts = rows.filter((l) => l.side === 'SHORT').reduce((s, l) => s + l.usd, 0);
  return { count: rows.length, longsUsd: longs, shortsUsd: shorts, streamConnected: Boolean(liqSocket && liqSocket.readyState === 1), recent: rows.slice(-10).reverse() };
}
