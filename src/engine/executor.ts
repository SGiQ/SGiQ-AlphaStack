import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { AlpacaCryptoClient, type CryptoBar, type Timeframe } from '../broker/alpacaCrypto.js';
import { getDb } from '../db/client.js';
import {
  strategies, runLogs, signals as signalsTable, positions, orders, drawdownState,
} from '../db/schema.js';
import { applyRiskLayer, evaluateDrawdown, type RiskConfig } from './risk.js';
import { momentumBreakout } from '../strategies/momentumBreakout.js';
import { meanReversion } from '../strategies/meanReversion.js';
import { trendFollowing } from '../strategies/trendFollowing.js';
import type { MarketContext, StrategyModule, StrategySignal } from '../strategies/types.js';

const REGISTRY: Record<string, StrategyModule<any>> = {
  momentum_breakout_v1: momentumBreakout,
  mean_reversion_v1: meanReversion,
  trend_following_v1: trendFollowing,
};

export interface ExecutorResult {
  runId: string;
  mode: 'paper' | 'live';
  totalSignals: number;
  accepted: number;
  skipped: number;
  killSwitchTripped: boolean;
}

/**
 * Single heartbeat cycle.
 *
 * Flow:
 *  1. Load enabled strategies from DB
 *  2. Pre-fetch bars per (symbol × timeframe) needed by the enabled strategies
 *  3. Read broker account state + positions
 *  4. Evaluate every strategy on every symbol; collect signals
 *  5. Apply risk layer (sizing, concurrency, kill switch)
 *  6. Persist run_log + signals; execute accepted intents; persist orders
 *  7. Recompute drawdown state, trip kill switch if needed
 */
export async function runOnce(): Promise<ExecutorResult> {
  const cfg = loadConfig();
  const db = getDb();
  const runId = randomUUID();
  const mode: 'paper' | 'live' = cfg.LIVE_TRADING ? 'live' : 'paper';
  const alpaca = new AlpacaCryptoClient({ mode });

  // 1. enabled strategies
  const enabled = await db
    .select()
    .from(strategies)
    .where(eq(strategies.enabled, true));
  const activeStrategies = enabled.filter((s) => REGISTRY[s.name]);

  // 2. pre-fetch bars
  const symbols = cfg.SYMBOLS;
  const tfsNeeded = new Set<Timeframe>();
  for (const s of activeStrategies) {
    for (const tf of REGISTRY[s.name]!.requiredTimeframes) tfsNeeded.add(tf);
  }
  const barsBySymbol: Record<string, Partial<Record<Timeframe, CryptoBar[]>>> = {};
  const currentPrices: Record<string, number> = {};
  for (const symbol of symbols) {
    barsBySymbol[symbol] = {};
    for (const tf of tfsNeeded) {
      barsBySymbol[symbol]![tf] = await alpaca.getBars(symbol, tf, 250);
    }
    const dailyBars = barsBySymbol[symbol]!['1Day'] ?? [];
    const last = dailyBars[dailyBars.length - 1]?.c ?? await alpaca.getLatestPrice(symbol);
    currentPrices[symbol] = last;
  }

  // 3. account + positions snapshot
  const account = await alpaca.getAccount();
  const equity = Number(account.equity);
  const cash = Number(account.cash);

  const openLocalPositions = await db
    .select()
    .from(positions)
    .where(eq(positions.status, 'open'));

  // 4. evaluate each strategy on each symbol
  const collectedSignals: StrategySignal[] = [];
  for (const dbStrategy of activeStrategies) {
    const mod = REGISTRY[dbStrategy.name]!;
    const params = dbStrategy.params as Record<string, unknown>;
    for (const symbol of symbols) {
      const ownPosition = openLocalPositions.find(
        (p) => p.symbol === symbol && p.strategyId === dbStrategy.id,
      );
      const ctx: MarketContext = {
        symbol,
        bars: barsBySymbol[symbol]!,
        lastPrice: currentPrices[symbol]!,
        position: ownPosition ? {
          id: ownPosition.id,
          symbol: ownPosition.symbol,
          qty: Number(ownPosition.qty),
          avgCost: Number(ownPosition.avgCost),
          stopLoss: ownPosition.stopLoss != null ? Number(ownPosition.stopLoss) : null,
          takeProfit: ownPosition.takeProfit != null ? Number(ownPosition.takeProfit) : null,
          openedAt: ownPosition.openedAt,
        } : null,
        account: { cash, equity, portfolioUsd: cfg.PORTFOLIO_USD },
      };
      const sigs = mod.evaluate(ctx, { ...mod.defaultParams, ...params });
      for (const sig of sigs) collectedSignals.push(sig);
    }
  }

  // 5. drawdown + kill-switch evaluation BEFORE risk layer
  const yearMonth = monthKey(new Date());
  const [existingDraw] = await db
    .select()
    .from(drawdownState)
    .where(eq(drawdownState.yearMonth, yearMonth));
  const dd = evaluateDrawdown({
    yearMonth,
    currentEquity: equity,
    previousPeak: existingDraw ? Number(existingDraw.peakEquity) : null,
    previousTripped: existingDraw?.killSwitchTripped ?? false,
    killSwitchPct: cfg.KILL_SWITCH_DRAWDOWN_PCT,
  });

  const riskCfg: RiskConfig = {
    portfolioUsd: cfg.PORTFOLIO_USD,
    equity,
    riskPerTradePct: cfg.RISK_PER_TRADE_PCT,
    maxConcurrent: cfg.MAX_CONCURRENT_POSITIONS,
    killSwitchTripped: dd.killSwitchTripped,
  };

  const sized = applyRiskLayer({
    signals: collectedSignals,
    currentPrices,
    openPositionCount: openLocalPositions.length,
    cfg: riskCfg,
  });

  // 6. persist run + signals
  await db.insert(runLogs).values({
    id: runId,
    mode,
    summary: {
      symbols,
      strategies: activeStrategies.map((s) => s.name),
      signalCount: collectedSignals.length,
      acceptedCount: sized.filter((x) => x.status === 'accepted').length,
      drawdownPct: dd.drawdownPct,
      killSwitchTripped: dd.killSwitchTripped,
      equity,
      cash,
    },
  });

  let accepted = 0;
  let skipped = 0;
  for (const item of sized) {
    const strat = activeStrategies.find((s) => s.name === item.signal.strategy);
    if (!strat) continue;
    const [signalRow] = await db.insert(signalsTable).values({
      runId,
      strategyId: strat.id,
      symbol: item.signal.symbol,
      side: item.signal.side,
      confidence: item.signal.confidence.toFixed(3),
      suggestedNotional: item.signal.suggestedNotional?.toString() ?? null,
      suggestedQty: item.signal.suggestedQty?.toString() ?? null,
      stopLoss: item.signal.stopLoss?.toString() ?? null,
      takeProfit: item.signal.takeProfit?.toString() ?? null,
      reason: item.signal.reason,
      skippedReason: item.status === 'skipped' ? item.skipReason : null,
    }).returning({ id: signalsTable.id });
    if (item.status === 'skipped') { skipped++; continue; }

    // Execute the accepted intent
    const clientOrderId = `alphastack-${runId.slice(0, 8)}-${item.signal.symbol.replace('/', '')}-${item.signal.side}`;
    try {
      const order = await alpaca.submitOrder({
        symbol: item.signal.symbol,
        side: item.signal.side,
        notional: item.notional > 0 ? item.notional : undefined,
        qty: item.qty,
        client_order_id: clientOrderId,
      });
      await db.insert(orders).values({
        runId,
        signalId: signalRow!.id,
        strategyId: strat.id,
        brokerOrderId: order.id,
        clientOrderId,
        symbol: item.signal.symbol,
        side: item.signal.side,
        notional: item.notional > 0 ? item.notional.toString() : null,
        qty: item.qty?.toString() ?? null,
        filledAvgPrice: order.filled_avg_price ?? null,
        status: order.status,
        reason: item.signal.reason,
      });
      accepted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.insert(orders).values({
        runId,
        signalId: signalRow!.id,
        strategyId: strat.id,
        clientOrderId,
        symbol: item.signal.symbol,
        side: item.signal.side,
        notional: item.notional > 0 ? item.notional.toString() : null,
        qty: item.qty?.toString() ?? null,
        status: 'error',
        reason: `${item.signal.reason} | ${msg}`,
      });
      skipped++;
    }
  }

  // 7. persist drawdown state
  await db
    .insert(drawdownState)
    .values({
      yearMonth,
      peakEquity: dd.peakEquity.toString(),
      currentEquity: equity.toString(),
      drawdownPct: dd.drawdownPct.toFixed(4),
      killSwitchTripped: dd.killSwitchTripped,
      trippedAt: dd.killSwitchTripped && !(existingDraw?.killSwitchTripped) ? new Date() : (existingDraw?.trippedAt ?? null),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: drawdownState.yearMonth,
      set: {
        peakEquity: dd.peakEquity.toString(),
        currentEquity: equity.toString(),
        drawdownPct: dd.drawdownPct.toFixed(4),
        killSwitchTripped: dd.killSwitchTripped,
        updatedAt: new Date(),
      },
    });

  return {
    runId, mode,
    totalSignals: collectedSignals.length,
    accepted, skipped,
    killSwitchTripped: dd.killSwitchTripped,
  };
}

function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
