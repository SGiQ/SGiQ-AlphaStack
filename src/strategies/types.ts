import type { CryptoBar, Timeframe } from '../broker/alpacaCrypto.js';

// ---------------------------------------------------------------------------
// MarketContext — everything a strategy needs to make a decision
//
// The executor pre-fetches bars at the timeframes the strategy declares it
// needs (see StrategyModule.requiredTimeframes) and packages them up alongside
// the current position (if any). This keeps strategies pure + testable.
// ---------------------------------------------------------------------------
export interface MarketContext {
  symbol: string;
  // Bars keyed by Alpaca timeframe string. Empty array if the strategy didn't
  // request that TF (strategies should only read TFs they asked for).
  bars: Partial<Record<Timeframe, CryptoBar[]>>;
  lastPrice: number;
  // Most recent open position for this symbol owned by THIS strategy.
  // null if flat or only owned by a different strategy.
  position: OwnedPosition | null;
  // Snapshot of broader account state (read-only, do not mutate)
  account: {
    cash: number;
    equity: number;
    portfolioUsd: number; // configured PORTFOLIO_USD
  };
}

export interface OwnedPosition {
  id: string;
  symbol: string;
  qty: number;
  avgCost: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: Date;
}

// ---------------------------------------------------------------------------
// Signal — the unit of output from a strategy.
//
// Notional / qty are SUGGESTED — the risk-management layer has the final say.
// stopLoss / takeProfit are price levels; the executor places them as
// separate stop orders after the entry fills.
// ---------------------------------------------------------------------------
export interface StrategySignal {
  strategy: string;          // 'momentum_breakout_v1'
  symbol: string;
  side: 'buy' | 'sell';
  confidence: number;        // 0..1 — strategy's own confidence score
  suggestedNotional?: number;
  suggestedQty?: number;
  stopLoss?: number;
  takeProfit?: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// StrategyModule — the contract every strategy implements.
//
// Per-strategy configuration (period tunables, thresholds) lives in the
// `params` field of the strategies DB row, which the executor reads and
// passes in as `cfg`.
// ---------------------------------------------------------------------------
export interface StrategyModule<TParams = Record<string, unknown>> {
  /** Stable name matching the strategies.name DB column. */
  readonly name: string;
  /** Which timeframes the executor must fetch bars for. */
  readonly requiredTimeframes: readonly Timeframe[];
  /** Default params (overridden by DB row). */
  readonly defaultParams: TParams;
  /** Pure evaluator. Returns 0+ signals based on the context. No IO. */
  evaluate(ctx: MarketContext, cfg: TParams): StrategySignal[];
}

// ---------------------------------------------------------------------------
// Strategy params — strongly-typed per strategy.
// These shapes match what the seed inserts into strategies.params.
// ---------------------------------------------------------------------------
export interface MomentumBreakoutParams {
  breakout_period: number;     // e.g. 20 (highest high over 20 daily bars)
  volume_mult: number;         // e.g. 1.5x 20-period avg volume
  rr_min: number;              // minimum reward-to-risk (3 = 1:3)
  rsi_overbought: number;      // skip entries if RSI > this (avoid chasing)
}

export interface MeanReversionParams {
  rsi_oversold: number;        // 30
  bollinger_period: number;    // 20
  bollinger_sigma: number;     // 2
}

export interface TrendFollowingParams {
  ema_fast: number;            // 21
  ema_mid: number;             // 55
  ema_slow: number;            // 200
  pullback_required: boolean;  // wait for pullback to ema_fast before entry
}
