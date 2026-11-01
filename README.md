# VelocityX Trading 3.0

A personal, multi-exchange AI trading platform for crypto and NSE forex (INR currency futures through Zerodha) for a single owner, built on the MERN stack (MongoDB optional, Express, React, Node).

## Platform (3.0)

| Area | What it does |
|---|---|
| **Login** | One owner (admin) account, plus public sign-up for regular user accounts ("Create account"; turn off with `ALLOW_SIGNUP=false`). The owner username comes from `ADMIN_USERNAME` in `server/.env`, and `ADMIN_PASSWORD` is the initial password. Change the password in the app, or reset it with "Forgot password" (code sent to Telegram) or by changing `ADMIN_PASSWORD` and restarting. Also: TOTP 2FA with QR code, sign-out-everywhere, activity/audit log. |
| **Security** | Live trades use your own exchange keys, encrypted at rest with AES-256-GCM. |
| **Forex (NSE via Zerodha)** | USDINR, EURINR, GBPINR and JPYINR near-month currency futures through Zerodha Kite Connect: charts, AI signals, backtests, paper trading in a separate INR wallet, and live bots. See "Forex (Zerodha)" below. |
| **Multi-exchange** | One adapter interface. Binance, Bybit and OKX support market data plus spot trading (testnet/demo supported). Kraken and Coinbase are market data and paper trading only. |
| **Admin panel** | System health, all bots and trades, errors, audit log, AI models, platform-wide trading halt, branding. |
| **Copy trading** | Leaders share bots. Followers mirror entries and exits sized to their own equity, with their own kill switch and exposure checks. Includes a leaderboard. |
| **Strategy marketplace** | A strategy builder (model weights, stop/target, regimes) plus publishing (auto out-of-sample benchmark), install and ratings. |
| **Developer API** | Read or trade API keys, `X-API-Key` auth, per-IP rate limits, a stable `/api/v1` base path, and in-app docs. |
| **Notifications** | In-app bell, browser notifications and Telegram alerts. |
| **Mobile app** | An installable PWA (manifest, service worker, icons). Add it to the home screen on Android or iOS. |
| **Research upgrades** | AI Grid strategy (fee-aware steps, regime-gated), multi-timeframe fusion (higher-timeframe trend and regime model plus alignment gate), economic calendar (CPI/FOMC/NFP) in the risk engine, backtests up to 20,000 candles. |

## AI pipeline

```
Market data (candles, order book, trades, futures, news)
  -> Feature engineering (indicators, regimes, volume delta)
  -> 7 models: Trend, Momentum, Mean Reversion, Volatility, Regime, Order Flow, Patterns  (+ Neural Net, Sentiment)
  -> Market regime detection -> strategy selection (AI Adaptive)
  -> Meta score -> empirically calibrated probability (this coin's own history)
  -> Expected return / expected risk / R:R / quality grade (A-D)
  -> Optional Claude review (can veto)
  -> Dynamic Risk Engine (sizing + hard gates) -> APPROVED / REJECTED
  -> Execution (paper order-book simulation or Binance) -> Trade Journal -> Learning Loop
```

## Modules

| Area | What it does |
|---|---|
| **Signal Engine 2.0** | Returns LONG / WAIT / EXIT with a probability, expected return after costs, expected risk, R:R, regime and quality grade. The probability is the take-profit-before-stop rate of similar past setups, adjusted toward the base rate when few setups exist. |
| **Regime detection** | Labels the market as Bull Trend, Bear Trend, Sideways, High Volatility, Low Volatility, Breakout, Breakdown or Panic, then picks the strategy that fits (trend, mean reversion or breakout), or stands aside |
| **Order Flow AI** | Bid/ask imbalance, spread, depth, large orders, buy/sell pressure, volume delta, liquidity walls, absorption, and possible spoofing (walls pulled before price reached them) |
| **Futures Intelligence** | Open interest, funding rate, long/short and top-trader ratios, taker ratio, basis, liquidations (live stream), the price/OI/funding relationship, and squeeze risk. Analytics only: VelocityX never places futures orders. |
| **News Intelligence** | Cointelegraph, Decrypt and CoinDesk RSS -> NLP (Claude, or a keyword fallback) -> sentiment, impact, category and assets -> risk adjustment |
| **Dynamic Risk Engine** | Base risk x volatility x drawdown x strategy performance x regime x news x futures x signal quality, then gates: kill switch, R:R, quality, daily loss, open positions, exposure, correlation |
| **Portfolio AI** | Allocation, exposure, correlation matrix, annualised volatility, risk level, concentration warnings, equity curve |
| **Emergency protection** | Kill switch (stop bots, cancel orders, close positions, disable trading), exchange health monitor, stale-data and abnormal-price guards, duplicate-order protection (cooldown + idempotent order IDs), auto-pause after repeated errors, and no trade when a model fails |
| **Paper Trading 2.0** | Fills against the live order book, with spread, market impact, partial fills, 80-350 ms latency, random rejections and fees |
| **Backtest Lab 2.0** | Multi-coin x multi-timeframe, a 70/15/15 train/validation/out-of-sample split, anchored walk-forward, Monte Carlo, the parameter optimizer, and fees/spread/slippage/latency/funding |
| **Strategy Library** | 11 strategies: Adaptive, Trend, Momentum, Mean Reversion, Breakout, Scalping, Volatility, Order Flow, Neural Net, DCA and Claude. Benchmarked out-of-sample for win rate, profit factor, drawdown, Sharpe, best timeframe and best regime. |
| **AI Scanner 2.0** | 50-150 coins -> liquidity -> volatility -> regime -> AI score -> risk filter -> top 10 setups (with live order flow) |
| **Trade Journal** | Post-analysis of every closed trade (direction, timing, volatility, profit give-back, regime flip, volume, quality), a recommendation, an optional Claude coach, and pattern mining ("your biggest losses happen when...") |
| **Learning Loop** | Forward-evaluates every live signal, measures live calibration and per-model performance, and keeps a model registry (candidate -> paper -> production) with out-of-sample gates and human approval. Nothing self-promotes to live trading. |
| **Bot Manager** | Many bots, each running through the central risk engine, with paper/live mode, DCA bots, auto-pause and per-bot logs |

## Quick start (Windows)

Set `ADMIN_PASSWORD` in `server/.env`, then double-click `start.bat` and sign in. Or, for development, run `npm run dev` in `server/` and in `client/`, then open http://localhost:5173.

## Configuration (`server/.env`)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on Claude for trade review/veto, news NLP, journal coaching and the assistant |
| `CLAUDE_MODEL` | Default `claude-opus-5-5` |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | Live spot trading only. Enable Spot trading only and **disable withdrawals**. |
| `BINANCE_TESTNET` | `true` (default) sends live-mode orders to the Spot Testnet |
| `MONGO_URI` | Optional. Without it, data is stored in `server/data/db.json`. |
| `PAPER_START_BALANCE` | Starting balance of the crypto paper wallet (default 10000 USDT) |
| `PAPER_FX_START_BALANCE` | Starting balance of the forex paper wallet (default 1000000 INR) |
| `PAPER_REJECT_RATE` | Simulated exchange rejection rate for paper orders (default 0.002) |
| `MASTER_KEY` | 64 hex chars that encrypt stored exchange keys. If empty, one is generated in `server/data/master.key`. **Back it up.** |
| `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` | Separate Super Admin login at `/superadmin` (subscription plans, user subscriptions, upgrade requests, payments). It cannot sign in to trading and trading accounts cannot sign in there. Development default: `superadmin` / `superadmin123` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | The login. `ADMIN_PASSWORD` is applied on first start and whenever you change it (restart), which is the offline password reset. Development default: `admin` / `admin123` |
| `APP_URL` | Public app URL (https in production) |
| `DATA_DIR` | Folder for `db.json` and `master.key` (default `server/data`) |

## Forex (Zerodha)

Indian residents may trade forex only in INR pairs on a recognised exchange (FEMA/RBI). Overseas forex brokers are not allowed. VelocityX trades NSE currency futures on **USDINR, EURINR, GBPINR and JPYINR** through **Zerodha Kite Connect**.

**Setup**
1. Create a Kite Connect app at https://developers.kite.trade (paid plan). Set its **Redirect URL** to `<APP_URL>/api/brokers/zerodha/callback`. For local use that is `http://localhost:5173/api/brokers/zerodha/callback`.
2. In the app, go to **Account → Exchange connections**, choose **Zerodha**, and save the API key and API secret.
3. Click **Log in to Kite**. Kite sessions end at 6:00 AM IST, so log in once each trading day. Bots wait, and you get an alert, until you do.
4. Pick **Zerodha (NSE forex)** in the top-bar exchange menu. Terminal, Dashboard, Portfolio, Risk, Backtest and Settings then switch to the forex (INR) account.

**How it trades**
- **Contracts:** orders go to the near-month futures contract. A new month is used 2 days before expiry, and an open position is closed 1 day before its contract expires.
- **Lots:** 1 lot = 1,000 units (1,000 USD, EUR or GBP, or 100,000 JPY). Orders are whole lots.
- **No leverage:** a lot needs its full rupee notional in the account (about ₹85,000 for USDINR).
- **Shorts (forex only):** turn on **Allow shorts** in a bot to let it sell first when the AI is bearish. Short probability is calibrated on the pair's own history of mirrored trades, and shorts are blocked in Bull Trend / Breakout regimes. The exchange stop is a BUY stop above the price, and the bot covers on a bullish signal. The Terminal also has Short / Cover buttons. In the **Backtest Lab**, turn on **Include shorts** to test both directions. Results show long and short trades separately (Regime tab), so you can see whether shorts actually add an edge. NSE stocks are delivery (CNC), so they cannot be shorted.
- **Orders:** entries and exits are marketable limit orders a couple of ticks through the book.
- **Stop-loss:** an exchange stop-loss (SL order) protects open positions. Kite orders are day orders, so the bot re-places the stop each morning.
- **Hours:** trading only happens Mon–Fri 09:00–17:00 IST. Positions are held overnight.
- **Costs:** fees use Zerodha's charges (brokerage min(₹20, 0.03%) plus GST and exchange charges).
- **Paper trading:** uses its own INR wallet (`PAPER_FX_START_BALANCE`, default ₹10,00,000) and fills against live Kite depth.
- **AI inputs:** crypto-only inputs (Binance futures, crypto news, fear & greed) are not used for forex. The economic calendar (CPI/FOMC/NFP) still applies.

## Stocks (NSE via Zerodha)

Uses the same Zerodha Kite login as forex. Pick **Zerodha (NSE stocks)** in the top-bar exchange menu.
- **Product:** delivery (CNC), long-only, whole shares, no leverage. Any NSE equity can be traded; NIFTY 50 is the default list.
- **Hours:** Mon-Fri 09:15-15:30 IST.
- **Stop-loss:** a GTT order on Zerodha, so it stays active overnight and while the server is off.
- **Charges:** real delivery charges (STT 0.1% each side, stamp duty, exchange fees, DP charge on sells).
- **Paper wallet:** its own INR wallet (PAPER_STOCKS_START_BALANCE, default 1000000).
- **Selling:** for bots to sell shares you hold, enable **DDPI** on your Zerodha account.

## Options (NSE via Zerodha)

Open **Options (NSE)** in the menu. It uses the same Zerodha Kite login. Underlyings are **NIFTY** and **BANKNIFTY** index options.

- **Defined risk only:** for calls and puts separately, the quantity bought must be at least the quantity sold, and the worst case at expiry must be finite. Naked selling is refused on the server.
- **Strategies:** Long Call, Long Put, Bull Call Spread, Bear Put Spread, Iron Condor, or custom legs (click B / S in the chain, up to 4 legs).
- **Chain:** live bid/ask, OI, IV and delta per strike, plus ATM IV, PCR and days to expiry.
- **Preview before every trade:**
  - Payoff chart, max profit and max loss, breakevens, probability of profit, greeks and round-trip charges.
  - Risk gates: kill switch, market hours, defined risk, max loss <= risk % of capital, open positions, days to expiry >= 1, liquidity, daily loss limit. Live trades also check Zerodha's basket margin.
- **Execution:** each leg is a marketable limit order. Opening places the bought legs first; closing buys back the sold legs first. If a leg fails, the legs already filled are reversed.
- **Exits:** checked every 30 s for auto-managed positions:
  - Take-profit at a % of max profit.
  - Stop at a % of max loss.
  - Always closed on the morning of expiry day.
- **Option bots:** the AI reads the index. Bullish -> bull call spread (or long call), bearish -> bear put spread (or long put), a quiet range -> iron condor. With **Require proven edge** on (the default), a direction is traded only when the AI's history-calibrated signal confirms it. The bot also exits when the AI view flips.
- **Paper wallet:** its own INR wallet (`PAPER_OPTIONS_START_BALANCE`, default 500000). Fills at the live bid/ask with Zerodha's F&O charges.
- **No backtests:** options cannot be backtested here, because Kite does not provide prices for expired contracts. Use paper trading to evaluate.
- **Risk:** SEBI found that about 9 in 10 individual F&O traders lose money. Start in paper mode.

## NSE holidays

Set `NSE_HOLIDAYS` in `server/.env` to the year's NSE trading holidays (YYYY-MM-DD, comma-separated, from nseindia.com). Forex and stock bots then stay idle on those days. Without the list, a holiday just has no new candles and the stale-data guard keeps bots from trading.

## Deploying to production

`start.bat` and the JSON file store are for running locally. On a server, set `NODE_ENV=production`. The app then refuses to start unless these are set:

- `MASTER_KEY`: 64 hex characters
- `MONGO_URI`
- `APP_URL`: must be an `https://` URL
- `ADMIN_PASSWORD`: at least 12 characters
- `SUPERADMIN_PASSWORD`: at least 12 characters (and `SUPERADMIN_USERNAME` different from `ADMIN_USERNAME`)

Production mode also changes these defaults:
- CORS is limited to `APP_URL` and `CORS_ORIGINS`.
- CSP and HSTS headers are sent.
- Client IPs are read from the reverse proxy (`TRUST_PROXY=1`).

**Docker (recommended).** This runs the app, MongoDB 7 and Caddy, which handles HTTPS automatically.

```bash
cp .env.production.example .env.production   # fill in DOMAIN, APP_URL, MASTER_KEY, ADMIN_PASSWORD
docker compose --env-file .env.production up -d --build
docker compose logs -f app
```

**VPS without Docker.** Install Node 20 or later and MongoDB. Then:
1. Run `npm run install:all && npm run build`.
2. Fill in `server/.env`.
3. Run `pm2 start deploy/ecosystem.config.cjs && pm2 save`.
4. Put `deploy/nginx.conf` (with certbot) in front of the app.

| Endpoint | Use |
|---|---|
| `/healthz` | Liveness check: the process is up |
| `/readyz` | Readiness check: the DB is connected and the app is not draining. Returns 503 otherwise. Used by the Docker healthcheck and Caddy. |

**Operations checklist**
- Back up `MASTER_KEY` somewhere outside the server. Without it, stored exchange keys can't be decrypted.
- Back up MongoDB every day, e.g. `docker compose exec mongo mongodump --archive --gzip > backup-$(date +%F).gz`.
- Run **one** app instance. Bot timers, rate limits and WebSocket fan-out live in process memory. Scale vertically.
- Shutdown is graceful. `docker stop` or `pm2 reload` stops taking traffic, waits for bot ticks in progress, and flushes the database. Running bots resume on the next start.
- Production logs are one JSON line per API request (stdout), plus `crash.log` in `DATA_DIR`.

## Before trading real money

Out-of-sample backtests and the strategy benchmark show **no proven edge yet**. Use the Backtest Lab, the Learning Loop and paper trading to find one, then the testnet. Only after that should you consider real funds, and only risk what you can afford to lose. This is not financial advice.
