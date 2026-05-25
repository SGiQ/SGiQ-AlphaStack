import { SimBroker, type SimBrokerConfig } from './broker.js';
import { getBarsCached } from './barFetcher.js';
import { applyRiskLayer } from '../engine/risk.js';
import { momentumBreakout } from '../strategies/momentumBreakout.js';
import { meanReversion } from '../strategies/meanReversion.js';
import { trendFollowing } from '../strategies/trendFollowing.js';
import type { StrategyModule, MarketContext, StrategySignal } from '../strategies/types.js';
import type { CryptoBar, Timeframe } from '../broker/alpacaCrypto.js';

export interface BacktestConfig {
  symbols: string[];
  start: string;       // ISO 8601
  end: string;
  startingCash: number;
  feeRate: number;
  riskPerTradePct: number;
  maxConcurrent: number;
  killSwitchPct: number;
  /** Strategy names to include (matches REGISTRY keys). */
  strategies?: string[];
}

const REGISTRY: Record<string, StrategyModule<any>> = {
  momentum_breakout_v1: momentumBreakout,
  mean_reversion_v1:    meanReversion,
  trend_following_v1:   trendFollowing,
};

/**
 * Slice bars[] to only those with t <= asOf (inclusive). Bars are sorted
 * ascending so we can use binary search for O(log n) windowing.
 */
function barsUpTo(bars: CryptoBar[], asOf: string): CryptoBar[] {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.t <= asOf) lo = mid + 1;
    else hi = mid;
  }
  return bars.slice(0, lo);
}

export interface BacktestResult {
  config: BacktestConfig;
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  totalTrades: number;
  killSwitchTripped: boolean;
  killSwitchFirstTrippedAt: string | null;
  byStrategy: Array<{
    name: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    grossPnl: number;
    avgPnlPct: number;
  }>;
  /** Benchmark: what the same capital would have done if just held. */
  benchmarks: {
    btcHodl: { returnPct: number; finalValue: number; maxDdPct: number };
    ethHodl: { returnPct: number; finalValue: number; maxDdPct: number };
    portfolio6040: { returnPct: number; finalValue: number; maxDdPct: number };
  };
  equityCurve: Array<{
    t: string;
    equity: number;
    drawdown: number;
    btcHodl: number;
    ethHodl: number;
    portfolio6040: number;
  }>;
  closedTrades: Array<{
    strategy: string; symbol: string;
    entryAt: string; exitAt: string;
    entryPrice: number; exitPrice: number;
    qty: number; pnl: number; pnlPct: number;
    exitKind: 'stop' | 'target' | 'manual';
  }>;
}

function monthKey(iso: string): string {
  return iso.slice(0, 7); // 'YYYY-MM'
}

function maxDrawdownPctOfSeries(values: number[]): number {
  let peak = -Infinity, worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (v - peak) / peak;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Replay loop:
 *   - Pre-fetch bars for every (symbol × timeframe) needed
 *   - Iterate daily bars (the slowest TF) as "ticks"
 *   - At each tick:
 *     * Fill any orders queued the previous tick at this bar's open
 *     * Check SL/TP triggers using this bar's high/low
 *     * Slice 4H/1H bars up to this point, build MarketContext
 *     * Evaluate each enabled strategy
 *     * Run signals through the risk layer
 *     * Queue accepted intents to fill at the next bar's open
 *     * Mark-to-market for the equity curve
 */
export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
  const strategiesToRun = (cfg.strategies ?? Object.keys(REGISTRY))
    .map((name) => REGISTRY[name])
    .filter((m): m is StrategyModule<any> => Boolean(m));
  if (!strategiesToRun.length) throw new Error('no strategies selected');

  // Collect required timeframes across all strategies
  const tfs = new Set<Timeframe>(['1Day']); // always need daily for the tick loop
  for (const s of strategiesToRun) for (const tf of s.requiredTimeframes) tfs.add(tf);

  // Pre-fetch all bars
  const bars: Record<string, Partial<Record<Timeframe, CryptoBar[]>>> = {};
  for (const symbol of cfg.symbols) {
    bars[symbol] = {};
    for (const tf of tfs) {
      bars[symbol]![tf] = await getBarsCached(symbol, tf, cfg.start, cfg.end);
    }
  }

  // Build a unified set of tick timestamps from each symbol's daily bars
  const tickStamps = new Set<string>();
  for (const symbol of cfg.symbols) {
    for (const b of bars[symbol]!['1Day'] ?? []) tickStamps.add(b.t);
  }
  const ticks = Array.from(tickStamps).sort();

  const brokerCfg: SimBrokerConfig = { startingCash: cfg.startingCash, feeRate: cfg.feeRate };
  const broker = new SimBroker(brokerCfg);

  // ---- Buy-and-hold benchmark setup ----
  // Capture the first available daily close per symbol — used as the "I held
  // since day one" entry price. We use close (not open) because that's the
  // price the SimBroker uses for mark-to-market consistency.
  const benchEntry: Record<string, number> = {};
  for (const symbol of cfg.symbols) {
    const firstBar = (bars[symbol]!['1Day'] ?? [])[0];
    if (firstBar) benchEntry[symbol] = firstBar.c;
  }
  // Pretend allocations for the 60/40 mix
  const btcUnits = benchEntry['BTC/USD'] ? (cfg.startingCash / benchEntry['BTC/USD']) : 0;
  const ethUnits = benchEntry['ETH/USD'] ? (cfg.startingCash / benchEntry['ETH/USD']) : 0;
  const btc6040Units = benchEntry['BTC/USD'] ? (cfg.startingCash * 0.6 / benchEntry['BTC/USD']) : 0;
  const eth6040Units = benchEntry['ETH/USD'] ? (cfg.startingCash * 0.4 / benchEntry['ETH/USD']) : 0;

  // ---- Kill-switch latching state, keyed by year-month (mirrors live) ----
  // The live executor stores one drawdown_state row per (year, month), and
  // once killSwitchTripped is true for a month it stays true until manual
  // reset. The previous backtest computed fresh each tick → switch flapped
  // off whenever DD recovered, allowing trades that wouldn't have happened
  // in live. Now we mirror live behavior month-by-month.
  const ddState = new Map<string, { peak: number; tripped: boolean; firstTrippedAt: string | null }>();
  let firstEverTrippedAt: string | null = null;

  for (const tickT of ticks) {
    // 1. Fill orders queued previously, at THIS tick's open price per symbol
    for (const symbol of cfg.symbols) {
      const dailyBars = bars[symbol]!['1Day'] ?? [];
      const todayBar = dailyBars.find((b) => b.t === tickT);
      if (!todayBar) continue;
      broker.fillPendingAtOpen(symbol, todayBar);

      // 2. Run SL/TP checks against the rest of today's range (high/low)
      broker.checkStopsAndTargets(symbol, todayBar);
    }

    // 3. Evaluate strategies using bars known up to (and including) today's close
    const collectedSignals: StrategySignal[] = [];
    const currentPrices: Record<string, number> = {};
    for (const symbol of cfg.symbols) {
      const dailyBars = bars[symbol]!['1Day'] ?? [];
      const todayBar = dailyBars.find((b) => b.t === tickT);
      if (!todayBar) continue;
      currentPrices[symbol] = todayBar.c;

      const ctxBars: Partial<Record<Timeframe, CryptoBar[]>> = {};
      for (const tf of tfs) {
        ctxBars[tf] = barsUpTo(bars[symbol]![tf] ?? [], tickT);
      }
      for (const strat of strategiesToRun) {
        const ownPosition = broker.positionFor(strat.name, symbol);
        const ctx: MarketContext = {
          symbol,
          bars: ctxBars,
          lastPrice: todayBar.c,
          position: ownPosition ? {
            id: ownPosition.id,
            symbol: ownPosition.symbol,
            qty: ownPosition.qty,
            avgCost: ownPosition.avgCost,
            stopLoss: ownPosition.stopLoss,
            takeProfit: ownPosition.takeProfit,
            openedAt: new Date(ownPosition.openedAt),
          } : null,
          account: { cash: broker.cash, equity: broker.equity(), portfolioUsd: cfg.startingCash },
        };
        const sigs = strat.evaluate(ctx, strat.defaultParams);
        for (const sig of sigs) collectedSignals.push(sig);
      }
    }

    // 4. Risk layer — latch the kill switch the same way the live executor
    // does. State is per-month and persists across ticks within that month.
    const equityNow = broker.equity();
    const mk = monthKey(tickT);
    const prev = ddState.get(mk);
    const peakThisMonth = Math.max(prev?.peak ?? equityNow, equityNow);
    const ddThisMonth = peakThisMonth > 0 ? (equityNow - peakThisMonth) / peakThisMonth : 0;
    const trippedNow = (prev?.tripped ?? false) || ddThisMonth <= -cfg.killSwitchPct;
    let firstTrippedAt = prev?.firstTrippedAt ?? null;
    if (trippedNow && !firstTrippedAt) {
      firstTrippedAt = tickT;
      if (!firstEverTrippedAt) firstEverTrippedAt = tickT;
    }
    ddState.set(mk, { peak: peakThisMonth, tripped: trippedNow, firstTrippedAt });

    const killSwitchTripped = trippedNow;
    const sized = applyRiskLayer({
      signals: collectedSignals,
      currentPrices,
      openPositionCount: broker.positions.length,
      cfg: {
        portfolioUsd: cfg.startingCash,
        equity: broker.equity(),
        riskPerTradePct: cfg.riskPerTradePct,
        maxConcurrent: cfg.maxConcurrent,
        killSwitchTripped,
      },
    });

    // 5. Queue accepted intents
    for (const intent of sized) {
      if (intent.status !== 'accepted') continue;
      broker.enqueueOrder({
        strategy: intent.signal.strategy,
        symbol: intent.signal.symbol,
        side: intent.signal.side,
        notional: intent.notional > 0 ? intent.notional : undefined,
        qty: intent.qty,
        stopLoss: intent.signal.stopLoss,
        takeProfit: intent.signal.takeProfit,
        reason: intent.signal.reason,
        decidedAt: tickT,
      });
    }

    // 6. Mark to market
    broker.recordEquity(tickT, currentPrices);
  }

  // ---- Benchmark mark-to-market over the full equity curve ----
  // Walk the broker.equityCurve and compute each benchmark's value at the
  // same timestamp using the daily close of the corresponding symbol.
  const dailyCloseByTimestamp: Record<string, Record<string, number>> = {};
  for (const symbol of cfg.symbols) {
    for (const b of bars[symbol]!['1Day'] ?? []) {
      if (!dailyCloseByTimestamp[b.t]) dailyCloseByTimestamp[b.t] = {};
      dailyCloseByTimestamp[b.t]![symbol] = b.c;
    }
  }
  const equityCurveWithBench = broker.equityCurve.map((e) => {
    const closes = dailyCloseByTimestamp[e.timestamp] ?? {};
    const btcPx = closes['BTC/USD'] ?? benchEntry['BTC/USD'] ?? 0;
    const ethPx = closes['ETH/USD'] ?? benchEntry['ETH/USD'] ?? 0;
    return {
      t: e.timestamp,
      equity: e.equity,
      drawdown: e.drawdownPct,
      btcHodl: btcUnits * btcPx,
      ethHodl: ethUnits * ethPx,
      portfolio6040: (btc6040Units * btcPx) + (eth6040Units * ethPx),
    };
  });

  const btcSeries = equityCurveWithBench.map((e) => e.btcHodl);
  const ethSeries = equityCurveWithBench.map((e) => e.ethHodl);
  const p6040Series = equityCurveWithBench.map((e) => e.portfolio6040);
  const last = equityCurveWithBench[equityCurveWithBench.length - 1];
  const btcFinal = last?.btcHodl ?? cfg.startingCash;
  const ethFinal = last?.ethHodl ?? cfg.startingCash;
  const p6040Final = last?.portfolio6040 ?? cfg.startingCash;

  // ---------- Build result ----------
  const totalTrades = broker.closedTrades.length;
  const stratNames = Array.from(new Set(strategiesToRun.map((s) => s.name)));
  const byStrategy = stratNames.map((name) => {
    const trades = broker.closedTrades.filter((t) => t.strategy === name);
    const wins = trades.filter((t) => t.pnl > 0).length;
    const losses = trades.filter((t) => t.pnl <= 0).length;
    const grossPnl = trades.reduce((a, t) => a + t.pnl, 0);
    const avgPnlPct = trades.length > 0
      ? trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length
      : 0;
    return {
      name,
      trades: trades.length,
      wins, losses,
      winRate: trades.length > 0 ? wins / trades.length : 0,
      grossPnl,
      avgPnlPct,
    };
  });

  return {
    config: cfg,
    finalEquity: broker.equity(),
    totalReturnPct: (broker.equity() - cfg.startingCash) / cfg.startingCash,
    maxDrawdownPct: broker.maxDrawdownPct(),
    totalTrades,
    killSwitchTripped: Boolean(firstEverTrippedAt),
    killSwitchFirstTrippedAt: firstEverTrippedAt,
    byStrategy,
    benchmarks: {
      btcHodl: {
        returnPct: (btcFinal - cfg.startingCash) / cfg.startingCash,
        finalValue: btcFinal,
        maxDdPct: maxDrawdownPctOfSeries(btcSeries),
      },
      ethHodl: {
        returnPct: (ethFinal - cfg.startingCash) / cfg.startingCash,
        finalValue: ethFinal,
        maxDdPct: maxDrawdownPctOfSeries(ethSeries),
      },
      portfolio6040: {
        returnPct: (p6040Final - cfg.startingCash) / cfg.startingCash,
        finalValue: p6040Final,
        maxDdPct: maxDrawdownPctOfSeries(p6040Series),
      },
    },
    equityCurve: equityCurveWithBench,
    closedTrades: broker.closedTrades,
  };
}
