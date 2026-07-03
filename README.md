# EVE Market Pulse Engine

EVE is a private market selection tool for M5 / M1 trading.

It ranks the cleanest market to focus on using:

- H1 intraday guardrail
- M15 main bias decision
- M5 current trade suitability
- No M1 scanning
- No supply and demand
- No WebSocket
- REST API polling only
- Backend scanner ON/OFF control
- Weekend crypto-only mode
- Manual price alarms per market

## Stack

- GitHub for source code
- Netlify for frontend + backend scheduled functions
- Supabase for settings, scan runs and market scores
- Twelve Data for candle data

## Markets included

1. XAU/USD
2. XAG/USD
3. EUR/USD
4. GBP/USD
5. USD/JPY
6. AUD/USD
7. USD/CAD
8. EUR/JPY
9. GBP/JPY
10. BTC/USD
11. ETH/USD
12. SOL/USD

## Timeframes used

EVE scans only:

- H1
- M15
- M5

It does not scan M1.

## Bias rule

EVE uses a stricter bias rule so the board does not turn everything bullish or bearish too easily.

- M15 is the main bias decision timeframe.
- Bullish only prints when M15 is bullish and either H1 or M5 also agrees.
- Bearish only prints when M15 is bearish and either H1 or M5 also agrees.
- If the agreement is weak, EVE marks the market as mixed.

Market cards show H1 / M15 / M5 mini labels so you can see the timeframe agreement quickly.

## Scanner schedule

The scheduled Netlify function runs every 5 minutes.

Each weekday full scan uses roughly:

```text
12 markets × 3 timeframes = 36 Twelve Data calls
```

When the scanner is turned OFF, the scheduled function still wakes up, checks Supabase, and stops immediately before making Twelve Data calls.

## Weekend behaviour

EVE detects market hours.

- Crypto is treated as 24/7.
- Forex is excluded when closed.
- Metals are excluded when closed or in daily break.
- Closed markets are greyed out and excluded from the ranking.

On weekends, EVE becomes crypto-only.

## Netlify environment variables

Set these in Netlify:

```text
TWELVEDATA_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
EVE_ADMIN_PASSWORD
```

Do not put these in GitHub.

Optional:

```text
TWELVEDATA_EXCHANGE
```

Leave it blank unless Twelve Data says you need a specific exchange value.

## Supabase setup

Open Supabase SQL Editor and run:

```text
supabase/eve-schema.sql
```

This creates:

- eve_settings
- eve_markets
- eve_scan_runs
- eve_market_scores
- eve_price_alarms

RLS is enabled. No browser policies are created because the browser talks only to Netlify functions. Netlify uses the service role key.

## Admin controls

The dashboard has:

- Turn Scanner On / Off
- Scan Now
- Set / Change Admin Password
- Enable Alarm Sound
- Set price alarm from each market card
- Acknowledge / delete triggered alarms

The admin password is checked by Netlify functions using `EVE_ADMIN_PASSWORD`. Price alarm changes are also protected by this password.

## Price alarms

Each market card has a Set Alarm button. EVE stores the target in Supabase and checks active alarms during each scan. When the scanned price reaches the target, the dashboard flashes and sounds an alarm after you have clicked Enable Alarm Sound once in the browser.

Because EVE uses REST polling, alarms trigger on scan updates, not tick-by-tick WebSocket ticks.

## Important

This is a market selection tool, not a trade execution bot. It does not place trades. It does not give direct buy/sell entries. Its job is to rank where your attention should go.
