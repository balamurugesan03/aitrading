# Binance relay (India VPS)

Binance.com rejects requests from US servers (HTTP 451, "restricted location").
The app stays on the main server; only its Binance calls go out through this relay on a VPS in an allowed region.

```
main app (US) --HTTPS + X-Relay-Key--> relay (India) --> api.binance.com / fapi.binance.com / fstream.binance.com
```

The relay only answers the main server's IP (`ALLOWED_IP`) carrying the shared secret (`RELAY_KEY`); everyone else is dropped.

> Use it only for Binance accounts whose holders live in a country Binance serves. It changes where the server
> connects from, not who is trading. Accounts of US residents must not be routed through it.

## 1. DNS
Add an A record `relay.velocityx.info` -> `172.83.83.197` (the India VPS).

## 2. India VPS
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.binance.com/api/v3/time   # must print 200
curl -fsSL https://get.docker.com | sh
git clone https://github.com/balamurugesan03/aitrading.git ai-trading-bot
cd ai-trading-bot/relay
cp .env.example .env
openssl rand -hex 32          # paste this into RELAY_KEY in .env
nano .env
docker compose --env-file .env run --rm relay caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file .env up -d
```
Ports 80 and 443 must be open (Caddy gets the HTTPS certificate automatically).

## 3. Main (US) server
Add to `.env.production` (same key as the relay):
```
BINANCE_RELAY_URL=https://relay.velocityx.info
BINANCE_RELAY_KEY=<the RELAY_KEY value>
```
Then `git pull && docker compose --env-file .env.production up -d --build`.

Test from the main server:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Relay-Key: <key>" https://relay.velocityx.info/api/v3/time   # 200
curl -s -o /dev/null -w "%{http_code}\n" https://relay.velocityx.info/api/v3/time                             # 403
```

## 4. Binance API keys
In each key's IP access restriction, whitelist **172.83.83.197** (the relay), not the main server's IP.

## Troubleshooting
`docker compose logs relay --tail 50` on the India VPS. A 403 from the relay means the key differs between the two
`.env` files; a dropped connection means the request did not come from `ALLOWED_IP`.
