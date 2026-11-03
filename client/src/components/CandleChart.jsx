import { useEffect, useRef } from 'react';
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts';
import { REGIME_STYLE } from './ui.jsx';

const theme = {
  layout: { background: { color: 'transparent' }, textColor: '#9a8fae', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
  grid: { vertLines: { color: 'rgba(217,182,92,0.05)' }, horzLines: { color: 'rgba(217,182,92,0.05)' } },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: 'rgba(148,163,199,0.15)' },
  timeScale: { borderColor: 'rgba(148,163,199,0.15)', timeVisible: true, secondsVisible: false },
};

const OVERLAY_STYLE = {
  ema9: { color: '#e8c872', lineWidth: 1 },
  ema21: { color: '#9b7bff', lineWidth: 1 },
  ema50: { color: '#2dd4bf', lineWidth: 1 },
  ema200: { color: '#ff5fa2', lineWidth: 2 },
  bbUpper: { color: 'rgba(110,168,255,0.55)', lineWidth: 1, lineStyle: LineStyle.Dashed },
  bbMid: { color: 'rgba(110,168,255,0.3)', lineWidth: 1, lineStyle: LineStyle.Dotted },
  bbLower: { color: 'rgba(110,168,255,0.55)', lineWidth: 1, lineStyle: LineStyle.Dashed },
};

const toLine = (candles, arr) => candles.map((c, i) => (arr?.[i] == null ? null : { time: c.time, value: arr[i] })).filter(Boolean);

export default function CandleChart({ data, show = {}, markers = [], live, height = 470, signalLevels }) {
  const box = useRef(null);
  const chart = useRef(null);
  const series = useRef({});
  const lines = useRef([]);

  useEffect(() => {
    const c = createChart(box.current, { ...theme, autoSize: true, height });
    chart.current = c;
    series.current.candles = c.addCandlestickSeries({
      upColor: '#16c784', downColor: '#ea3943', borderVisible: false, wickUpColor: '#16c784', wickDownColor: '#ea3943',
    });
    series.current.volume = c.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0.04 } });
    // Thin regime strip along the bottom edge: each candle coloured by its detected market regime.
    series.current.regime = c.addHistogramSeries({ priceScaleId: 'regime', lastValueVisible: false, priceLineVisible: false, base: 0 });
    c.priceScale('regime').applyOptions({ scaleMargins: { top: 0.975, bottom: 0 }, visible: false });
    Object.entries(OVERLAY_STYLE).forEach(([k, st]) => {
      series.current[k] = c.addLineSeries({ ...st, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    });
    return () => c.remove();
  }, [height]);

  useEffect(() => {
    if (!data?.candles?.length) return;
    const { candles, overlays } = data;
    series.current.candles.setData(candles);
    series.current.volume.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(22,199,132,0.35)' : 'rgba(234,57,67,0.35)' })));
    series.current.regime.setData(show.regime && data.regimes ? candles.map((c2, i) => ({ time: c2.time, value: 1, color: data.regimes[i] ? REGIME_STYLE[data.regimes[i]].color : 'rgba(0,0,0,0)' })) : []);
    Object.keys(OVERLAY_STYLE).forEach((k) => {
      const on = k.startsWith('bb') ? show.bb : show[k];
      series.current[k].setData(on ? toLine(candles, overlays[k]) : []);
    });
    chart.current.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, show.ema9, show.ema21, show.ema50, show.ema200, show.bb, show.regime]);

  // Support/resistance + AI stop/target price lines.
  useEffect(() => {
    const s = series.current.candles;
    if (!s) return;
    lines.current.forEach((l) => s.removePriceLine(l));
    lines.current = [];
    const add = (price, color, title, style = LineStyle.Dotted) =>
      lines.current.push(s.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    if (show.levels && data?.levels) {
      data.levels.supports.forEach((l) => add(l.price, 'rgba(22,199,132,0.6)', `S x${l.touches}`));
      data.levels.resistances.forEach((l) => add(l.price, 'rgba(234,57,67,0.6)', `R x${l.touches}`));
    }
    if (signalLevels) {
      add(signalLevels.stopLoss, '#ea3943', 'AI SL', LineStyle.Dashed);
      add(signalLevels.takeProfit, '#16c784', 'AI TP', LineStyle.Dashed);
    }
  }, [data, show.levels, signalLevels]);

  useEffect(() => {
    series.current.candles?.setMarkers([...markers].sort((a, b) => a.time - b.time));
  }, [markers, data]);

  useEffect(() => {
    if (!live || !data?.candles?.length) return;
    const lastTime = data.candles[data.candles.length - 1].time;
    if (live.time < lastTime) return;
    series.current.candles.update(live);
    series.current.volume.update({ time: live.time, value: live.volume, color: live.close >= live.open ? 'rgba(22,199,132,0.35)' : 'rgba(234,57,67,0.35)' });
  }, [live, data]);

  return <div ref={box} className="chart-box" style={{ height }} />;
}

// Small oscillator pane (RSI or MACD).
export function OscillatorChart({ data, kind = 'rsi', height = 150 }) {
  const box = useRef(null);
  useEffect(() => {
    if (!data?.candles?.length) return undefined;
    const c = createChart(box.current, { ...theme, autoSize: true, height });
    const { candles, oscillators: o } = data;
    if (kind === 'rsi') {
      const s = c.addLineSeries({ color: '#b3a1ff', lineWidth: 2, priceLineVisible: false });
      s.setData(toLine(candles, o.rsi));
      [70, 30].forEach((p) => s.createPriceLine({ price: p, color: p === 70 ? 'rgba(234,57,67,0.5)' : 'rgba(22,199,132,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false }));
    } else {
      const h = c.addHistogramSeries({ priceLineVisible: false });
      h.setData(candles.map((cd, i) => (o.macdHist[i] == null ? null : { time: cd.time, value: o.macdHist[i], color: o.macdHist[i] >= 0 ? 'rgba(22,199,132,0.6)' : 'rgba(234,57,67,0.6)' })).filter(Boolean));
      c.addLineSeries({ color: '#e8c872', lineWidth: 1, priceLineVisible: false }).setData(toLine(candles, o.macd));
      c.addLineSeries({ color: '#f5a524', lineWidth: 1, priceLineVisible: false }).setData(toLine(candles, o.macdSignal));
    }
    c.timeScale().fitContent();
    return () => c.remove();
  }, [data, kind, height]);
  return <div ref={box} className="chart-box sm" style={{ height }} />;
}

// Equity curve (area) for backtests.
export function EquityChart({ points, height = 300, marker }) {
  const box = useRef(null);
  useEffect(() => {
    if (!points?.length) return undefined;
    const c = createChart(box.current, { ...theme, autoSize: true, height });
    const up = points[points.length - 1].value >= points[0].value;
    const s = c.addAreaSeries({
      lineColor: up ? '#16c784' : '#ea3943', topColor: up ? 'rgba(22,199,132,0.35)' : 'rgba(234,57,67,0.35)', bottomColor: 'rgba(0,0,0,0)', lineWidth: 2,
    });
    s.setData(points.map((p) => ({ time: p.time, value: p.value })));
    if (marker) {
      const t = points.find((p) => p.time >= marker.time)?.time;
      if (t) s.setMarkers([{ time: t, position: 'aboveBar', color: '#e8c872', shape: 'arrowDown', text: marker.text }]);
    }
    if (points[0].price) {
      const start = points[0].value;
      const p0 = points[0].price;
      const bh = c.addLineSeries({ color: 'rgba(154,165,189,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
      bh.setData(points.map((p) => ({ time: p.time, value: (start * p.price) / p0 })));
    }
    c.timeScale().fitContent();
    return () => c.remove();
  }, [points, height, marker?.time]);
  return <div ref={box} className="chart-box" style={{ height }} />;
}
