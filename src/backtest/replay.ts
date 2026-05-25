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
  byStrategy: Array<{
    name: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    grossPnl: number;
    avgPnlPct: number;
  }>;
  equityCurve: Array<{ t: string; equity: number; drawdown: number }>;
  closedTrades: Array<{
    strategy: string; symbol: string;
    entryAt: string; exitAt: string;
    entryPrice: number; exitPrice: number;
    qty: number; pnl: number; pnlPct: number;
    exitKind: 'stop' | 'target' | 'manual';
  }>;
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

    // 4. Risk layer
    const dd = broker.maxDrawdownPct();
    const killSwitchTripped = dd <= -cfg.killSwitchPct;
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
    byStrategy,
    equityCurve: broker.equityCurve.map((e) => ({
      t: e.timestamp, equity: e.equity, drawdown: e.drawdownPct,
    })),
    closedTrades: broker.closedTrades,
  };
}
