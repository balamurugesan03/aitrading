import { useEffect, useRef, useState, useCallback } from 'react';
import { api, getToken } from './api.js';

// Polls an API endpoint. Returns [data, error, reload].
export function usePoll(url, ms = 0, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    if (!url) return;
    try {
      setData(await api.get(url));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [url]);
  useEffect(() => {
    load();
    if (!ms) return undefined;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ms, ...deps]);
  return [data, error, load];
}

// Subscribes to the server's bot event WebSocket (logs, trades, signals, positions).
export function useServerEvents(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let ws;
    let closed = false;
    let retry;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const t = getToken();
      if (!t) { retry = setTimeout(connect, 3000); return; }
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(t)}`);
      ws.onmessage = (e) => {
        try {
          const { type, payload } = JSON.parse(e.data);
          ref.current(type, payload);
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
}

const STREAM_HOSTS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];

// Direct Binance WebSocket stream from the browser (falls back to the public data mirror).
export function useBinanceStream(streams, onMessage) {
  const ref = useRef(onMessage);
  ref.current = onMessage;
  const key = streams.filter(Boolean).join('/');
  useEffect(() => {
    if (!key) return undefined;
    let ws;
    let hostIdx = 0;
    let closed = false;
    let retry;
    let opened = false;
    const connect = () => {
      opened = false;
      ws = new WebSocket(`${STREAM_HOSTS[hostIdx]}/stream?streams=${key}`);
      ws.onopen = () => (opened = true);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.data) ref.current(msg.data, msg.stream);
      };
      ws.onclose = () => {
        if (closed) return;
        if (!opened) hostIdx = (hostIdx + 1) % STREAM_HOSTS.length;
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [key]);
}

export function useLocalState(key, initial) {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s !== null ? JSON.parse(s) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch { /* storage unavailable */ }
  }, [key, v]);
  return [v, setV];
}
