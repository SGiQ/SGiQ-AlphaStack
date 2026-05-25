# SGiQ-AlphaStack

Multi-strategy crypto trading bot. The "aggressive" sleeve that complements
[DCATradeBot](https://github.com/SGiQ/DCATradeBot)'s conservative DCA core.

## Architecture

Three strategies running in parallel against a shared risk-management layer.
Signals are generated independently per strategy, then validated, sized, and
executed through one centralised executor so capital + concurrent-position
limits are enforced globally.

```
                  ┌────────────────────────────────────┐
                  │  Strategies (each emits Signal[])  │
                  │                                     │
   bars + state ──┤   1. Momentum breakout (4H + 1D)   ├──┐
                  │   2. Mean reversion   (1H + 4H)    │  │
                  │   3. Trend following  (1D)         │  │
                  └────────────────────────────────────┘  │
                                                          ▼
                                          ┌─────────────────────────────┐
                                          │  Risk-management layer       │
                                          │  - 2% per-trade sizing       │
                                          │  - max 5 concurrent          │
                                          │  - ATR-based stops           │
                                          │  - -15% monthly kill switch  │
                                          └──────────┬──────────────────┘
                                                     ▼
                                          ┌─────────────────────────────┐
                                          │  Executor → Alpaca paper     │
                                          └─────────────────────────────┘
```

## Strategy 4 deferred
The original plan called for a fourth strategy (funding-rate arbitrage). It
requires perpetual futures, which are unavailable on US-accessible spot
venues (Coinbase, Kraken, Alpaca). Adding it later means either CME futures
(via a futures broker) or on-chain perps (Hyperliquid / Drift). Until then
the 10% allocation it would have used is split across the three live
strategies; the 5% cash reserve is unchanged.

## Setup
```bash
cp .env.example .env           # fill in paper keys + DATABASE_URL
npm install
npm run db:migrate
npm run db:seed                # seeds strategies table with default weights
npm run run:once               # one heartbeat cycle (paper)
npm start                      # full cron loop
```

## Realistic expectations
The plan that motivated this build targets 26x in 12 months. On unlevered US
spot crypto that is a moonshot, not a baseline. Internal sizing is calibrated
for the **risk-adjusted** band ($150K–$300K from $37.5K = 4–8x), with the
1MM outcome treated as right-tail upside if the cycle cooperates.
