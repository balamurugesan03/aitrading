// Claude integration: structured trade decisions + streaming AI trading assistant.
import Anthropic from '@anthropic-ai/sdk';
import { config, hasClaude } from '../config.js';

let client = null;
const getClient = () => (client ||= new Anthropic({ apiKey: config.anthropicKey }));

// Server-side fallback: if a request is declined by a safety classifier, the API re-runs it on
// Anthropic's recommended fallback model instead of returning the refusal.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const ANALYST_SYSTEM = `You are VelocityX, a senior quantitative crypto trader working inside an automated spot-trading system on Binance.
You receive a pre-computed market dossier: the detected market regime and the strategy selected for it, scores from
seven models (trend, momentum, mean reversion, volatility, regime, order flow, patterns) plus a neural-network forecast,
live order-book flow, futures positioning (funding, open interest, long/short ratio), news sentiment, support/resistance
and the bot's current position. A separate risk engine sizes and may still reject the trade - your job is the market view.

Decide one action for the next period: BUY (open/add a long), SELL (close the long / stay out), or HOLD (do nothing).
This is spot trading, so there are no shorts: SELL only makes sense when a position is open or to confirm staying flat.

Principles:
- Capital preservation first. When signals conflict or are weak, prefer HOLD.
- Treat the ML probability with skepticism proportional to its validation accuracy (accuracy near 0.5 = barely better than a coin flip).
- Stops belong beyond a meaningful level (support, ATR multiple), not at arbitrary percentages.
- Aim for a reward:risk of at least 1.5 on BUY decisions.
- confidence is 0-100 and should reflect genuine conviction; reserve 80+ for strong multi-factor confluence.
- entry, stopLoss and takeProfit are absolute prices in the quote currency. For HOLD/SELL use the current price for entry and
  sensible reference levels for the others.
Keep reasoning concise (3-6 sentences) and specific to the numbers you were given.`;

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
    confidence: { type: 'integer' },
    entry: { type: 'number' },
    stopLoss: { type: 'number' },
    takeProfit: { type: 'number' },
    outlook: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
    reasoning: { type: 'string' },
    keyRisks: { type: 'array', items: { type: 'string' } },
  },
  required: ['action', 'confidence', 'entry', 'stopLoss', 'takeProfit', 'outlook', 'reasoning', 'keyRisks'],
  additionalProperties: false,
};

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid ANTHROPIC_API_KEY';
  if (err instanceof Anthropic.RateLimitError) return 'Claude rate limit reached - try again shortly';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err.message;
}

export async function claudeDecision(dossier) {
  if (!hasClaude()) return { available: false, error: 'ANTHROPIC_API_KEY not set' };
  try {
    const response = await getClient().beta.messages.create({
      ...FALLBACK,
      model: config.claudeModel,
      max_tokens: 16000,
      system: ANALYST_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: DECISION_SCHEMA } },
      messages: [{ role: 'user', content: `Market dossier (JSON):\n${JSON.stringify(dossier)}` }],
    });
    if (response.stop_reason === 'refusal') {
      return { available: true, error: 'Claude declined this request', model: response.model };
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const decision = JSON.parse(text);
    decision.confidence = Math.max(0, Math.min(100, Math.round(decision.confidence)));
    return {
      available: true,
      model: response.model,
      decision,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  } catch (err) {
    return { available: true, error: describeError(err) };
  }
}

const ASSISTANT_SYSTEM = `You are VelocityX AI, the built-in assistant of an AI crypto trading terminal connected to Binance.
You help the user understand markets, indicators, the bot's signals, risk management and strategy design.
Each user message may include a live market snapshot in a <market_context> block - ground your answers in it and quote numbers.
Be direct and practical. Use short markdown sections and bullet points. When the user asks about trading a specific coin,
give a clear view (bias, key levels, invalidation) and always mention position sizing / risk.
Never promise profits; crypto is highly volatile and this is not financial advice.
The user may write in English, Tamil or Tanglish - reply in the same style they use.`;

export async function streamAssistant({ history, userMessage, marketContext, onText }) {
  if (!hasClaude()) throw new Error('ANTHROPIC_API_KEY not set in server/.env');
  const content = marketContext
    ? `<market_context>\n${JSON.stringify(marketContext)}\n</market_context>\n\n${userMessage}`
    : userMessage;
  const stream = getClient().beta.messages.stream({
    ...FALLBACK,
    model: config.claudeModel,
    max_tokens: 64000,
    system: [{ type: 'text', text: ASSISTANT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'medium' },
    messages: [...history, { role: 'user', content }],
  });
  stream.on('text', onText);
  try {
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') onText('\n\n_Claude declined to answer this request._');
    return final;
  } catch (err) {
    throw new Error(describeError(err));
  }
}

const NEWS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          sentiment: { type: 'integer' },
          impact: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
          category: { type: 'string', enum: ['etf', 'regulation', 'macro', 'security', 'exchange', 'adoption', 'market', 'other'] },
          assets: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'sentiment', 'impact', 'category', 'assets'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

// Classifies crypto headlines: sentiment -100..100, market impact, category and affected tickers.
export async function classifyHeadlines(headlines) {
  if (!hasClaude() || !headlines.length) return null;
  try {
    const response = await getClient().beta.messages.create({
      ...FALLBACK,
      model: config.claudeModel,
      max_tokens: 16000,
      system: 'You are a crypto market news analyst. For each numbered headline return: sentiment from -100 (very bearish for crypto prices) to +100 (very bullish); impact on prices in the next 24h (LOW/MEDIUM/HIGH); category; and the tickers it directly affects (e.g. BTC, ETH, SOL; empty if none). Macro, ETF, regulation and major hacks are usually HIGH impact.',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: NEWS_SCHEMA } },
      messages: [{ role: 'user', content: headlines.map((h, i) => `${i}. ${h}`).join('\n') }],
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text).items.map((x) => ({
      ...x,
      sentiment: Math.max(-100, Math.min(100, Math.round(x.sentiment))),
      assets: x.assets.map((a) => a.toUpperCase()),
    }));
  } catch {
    return null;
  }
}

// Writes a short post-trade review from the journal's structured findings.
export async function reviewTrade(journalEntry) {
  if (!hasClaude()) return null;
  try {
    const response = await getClient().beta.messages.create({
      ...FALLBACK,
      model: config.claudeModel,
      max_tokens: 4000,
      system: 'You are a trading coach. Given a closed trade with its entry context, exit context and rule-based findings, write 2-3 sentences: why it won or lost, and one concrete rule to apply next time. Plain text, no markdown.',
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: JSON.stringify(journalEntry) }],
    });
    if (response.stop_reason === 'refusal') return null;
    return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  } catch {
    return null;
  }
}
