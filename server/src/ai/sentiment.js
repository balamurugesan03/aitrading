// Market sentiment: Crypto Fear & Greed index (alternative.me), cached for 10 minutes.
let cached = null;

export async function getFearGreed() {
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=30', { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    const data = {
      value: +json.data[0].value,
      label: json.data[0].value_classification,
      history: json.data.map((d) => ({ time: +d.timestamp, value: +d.value })).reverse(),
    };
    cached = { at: Date.now(), data };
    return data;
  } catch {
    return cached?.data || { value: 50, label: 'Neutral', history: [], unavailable: true };
  }
}
