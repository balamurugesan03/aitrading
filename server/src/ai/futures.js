// Futures Intelligence: open interest, funding, long/short crowding, basis and liquidations.
import * as fx from '../exchange/binanceFutures.js';
import { clamp } from './technical.js';

const cache = new Map();

export async function analyzeFutures(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  let data;
  try {
    const [prem, funding, oi, ls, top, taker, tick] = await Promise.all([
      fx.getPremiumIndex(symbol), fx.getFundingHistory(symbol, 30), fx.getOpenInterestHist(symbol, '1h', 48),
      fx.getLongShortRatio(symbol, '1h', 48), fx.getTopTraderRatio(symbol, '1h', 24).catch(() => []),
      fx.getTakerRatio(symbol, '1h', 24).catch(() => []), fx.getFuturesTicker(symbol),
    ]);
    const mark = +prem.markPrice;
    const index = +prem.indexPrice;
    const fundingNow = +prem.lastFundingRate * 100; // % per 8h
    const fundingAvg = funding.reduce((s, f) => s + +f.fundingRate, 0) / (funding.length || 1) * 100;
    const fundingPrev = funding.length > 3 ? +funding.at(-4).fundingRate * 100 : fundingNow;
    const oiNow = +oi.at(-1).sumOpenInterestValue;
    const oi24 = oi.length > 24 ? +oi.at(-25).sumOpenInterestValue : +oi[0].sumOpenInterestValue;
    const oiChange = ((oiNow - oi24) / oi24) * 100;
    const priceChange = +tick.priceChangePercent;
    const lsNow = +ls.at(-1).longShortRatio;
    const lsPrev = ls.length > 24 ? +ls.at(-25).longShortRatio : +ls[0].longShortRatio;
    const topNow = top.length ? +top.at(-1).longShortRatio : null;
    const takerNow = taker.length ? +taker.at(-1).buySellRatio : null;
    const basisPct = ((mark - index) / index) * 100;
    const liq = fx.getLiquidations(symbol);

    // Price / OI / funding relationship
    let relationship;
    const risks = [];
    if (priceChange > 0.5 && oiChange > 2) {
      relationship = 'Price up + OI up: new longs, leverage increasing';
      if (fundingNow > 0.03) risks.push('Funding elevated with rising OI - potential long squeeze');
    } else if (priceChange > 0.5 && oiChange < -2) {
      relationship = 'Price up + OI down: short covering, weaker rally';
    } else if (priceChange < -0.5 && oiChange > 2) {
      relationship = 'Price down + OI up: new shorts entering';
      if (fundingNow < -0.01) risks.push('Negative funding with rising shorts - potential short squeeze');
    } else if (priceChange < -0.5 && oiChange < -2) {
      relationship = 'Price down + OI down: longs closing / liquidating';
    } else {
      relationship = 'Price and OI flat: no leverage build-up';
    }
    if (priceChange > 1 && fundingNow < fundingPrev - 0.005) risks.push('Funding divergence: price rising while funding falls');
    if (lsNow > 2.5) risks.push(`Crowded longs: ${lsNow.toFixed(2)} long/short account ratio`);
    if (lsNow < 0.7) risks.push(`Crowded shorts: ${lsNow.toFixed(2)} long/short account ratio`);
    if (liq.longsUsd > 5e6 && liq.longsUsd > liq.shortsUsd * 3) risks.push('Heavy long liquidations in the last 24h');

    // Score: contrarian on crowding, positive when leverage is healthy and buyers aggress.
    let score = 0;
    score -= clamp((fundingNow - 0.01) * 800, -30, 30);
    score -= clamp((lsNow - 1.2) * 20, -25, 25);
    if (relationship.startsWith('Price up + OI up') && fundingNow < 0.03) score += 15;
    if (relationship.startsWith('Price up + OI down')) score -= 10;
    if (takerNow !== null) score += clamp((takerNow - 1) * 60, -20, 20);
    score = clamp(score);

    data = {
      available: true, symbol, score,
      squeezeRisk: risks.some((r) => r.includes('squeeze')),
      fundingRatePct: +fundingNow.toFixed(4), fundingAvg30Pct: +fundingAvg.toFixed(4),
      nextFundingTime: prem.nextFundingTime,
      openInterestUsd: Math.round(oiNow), oiChange24hPct: +oiChange.toFixed(2),
      priceChange24hPct: priceChange, longShortRatio: +lsNow.toFixed(3), longShortChange: +(lsNow - lsPrev).toFixed(3),
      topTraderRatio: topNow, takerBuySellRatio: takerNow, basisPct: +basisPct.toFixed(4),
      futuresVolumeUsd: Math.round(+tick.quoteVolume), liquidations: liq, relationship, risks,
      oiSeries: oi.map((o) => ({ time: Math.floor(o.timestamp / 1000), value: +o.sumOpenInterestValue })),
      fundingSeries: funding.map((f) => ({ time: Math.floor(f.fundingTime / 1000), value: +f.fundingRate * 100 })),
    };
  } catch (err) {
    data = { available: false, symbol, score: 0, risks: [], error: err.status === 400 ? 'No USD-M perpetual for this pair' : err.message };
  }
  cache.set(symbol, { at: Date.now(), data });
  return data;
}
