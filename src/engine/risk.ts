import type { StrategySignal } from '../strategies/types.js';

export interface RiskConfig {
  portfolioUsd: number;        // configured target portfolio size
  equity: number;              // current broker equity (cash + market value)
  riskPerTradePct: number;     // e.g. 0.02 = 2%
  maxConcurrent: number;       // hard cap across all strategies
  killSwitchTripped: boolean;  // if true, all signals are blocked
}

export interface SizedIntent {
  signal: StrategySignal;
  notional: number;            // USD to deploy
  qty?: number;                // for sells
  status: 'accepted' | 'skipped';
  skipReason?: string;
}

/**
 * Risk-management layer.
 *
 * Inputs: a list of signals from all strategies + current portfolio state +
 * count of open positions.
 *
 * Output: a parallel list of sized intents. Some may be 'skipped' with a
 * reason (kill switch, max concurrent reached, signal lacks stop loss for
 * sizing, etc.) — the executor still persists them so we have a full audit
 * trail of "what could have happened".
 *
 * Sizing: position size = (riskPerTradePct × equity) / risk_per_unit
 *   where risk_per_unit = |entry - stopLoss|
 *
 * If a signal has no stopLoss we can't size it — skipped.
 *
 * Sort by confidence descending so highest-conviction signals consume the
 * concurrent-position budget first.
 */
export function applyRiskLayer(input: {
  signals: StrategySignal[];
  currentPrices: Record<string, number>;
  openPositionCount: number;
  cfg: RiskConfig;
}): SizedIntent[] {
  const { signals, currentPrices, openPositionCount, cfg } = input;

  if (cfg.killSwitchTripped) {
    return signals.map((s) => ({
      signal: s, notional: 0,
      status: 'skipped',
      skipReason: 'kill switch tripped (monthly drawdown breached)',
    }));
  }

  const sorted = [...signals].sort((a, b) => b.confidence - a.confidence);
  const budget = Math.max(0, cfg.maxConcurrent - openPositionCount);
  let accepted = 0;
  const results: SizedIntent[] = [];

  for (const sig of sorted) {
    if (sig.side === 'sell') {
      // Closing a position — no sizing logic, the strategy provides qty
      results.push({
        signal: sig, notional: 0, qty: sig.suggestedQty,
        status: 'accepted',
      });
      continue;
    }

    if (accepted >= budget) {
      results.push({
        signal: sig, notional: 0,
        status: 'skipped',
        skipReason: `max concurrent positions reached (${cfg.maxConcurrent})`,
      });
      continue;
    }

    if (sig.stopLoss === undefined) {
      results.push({
        signal: sig, notional: 0,
        status: 'skipped',
        skipReason: 'no stopLoss provided — cannot size',
      });
      continue;
    }

    const entry = currentPrices[sig.symbol];
    if (entry === undefined || !Number.isFinite(entry) || entry <= 0) {
      results.push({
        signal: sig, notional: 0,
        status: 'skipped',
        skipReason: `no current price for ${sig.symbol}`,
      });
      continue;
    }

    const riskPerUnit = Math.abs(entry - sig.stopLoss);
    if (riskPerUnit <= 0) {
      results.push({
        signal: sig, notional: 0,
        status: 'skipped',
        skipReason: `risk_per_unit <= 0 (entry=${entry} sl=${sig.stopLoss})`,
      });
      continue;
    }

    const riskDollars = cfg.equity * cfg.riskPerTradePct;
    const units = riskDollars / riskPerUnit;
    const notional = round2(units * entry);
    if (notional <= 0) {
      results.push({
        signal: sig, notional: 0,
        status: 'skipped',
        skipReason: 'computed notional <= 0',
      });
      continue;
    }

    // Hard cap: never deploy more than 20% of equity per single trade,
    // even if the stop is tight (defends against bad SL placement)
    const cappedNotional = Math.min(notional, cfg.equity * 0.20);

    results.push({
      signal: sig, notional: round2(cappedNotional),
      status: 'accepted',
    });
    accepted++;
  }

  // Return in original signal order for predictable logging
  return signals.map((s) => results.find((r) => r.signal === s)!);
}

/**
 * Update drawdown state. Returns { drawdownPct, killSwitchTripped, peakEquity }.
 * Caller persists the result to the drawdown_state table.
 */
export function evaluateDrawdown(input: {
  yearMonth: string;
  currentEquity: number;
  previousPeak: number | null;
  previousTripped: boolean;
  killSwitchPct: number;
}): { peakEquity: number; drawdownPct: number; killSwitchTripped: boolean } {
  const peak = Math.max(input.previousPeak ?? input.currentEquity, input.currentEquity);
  const drawdown = peak > 0 ? (input.currentEquity - peak) / peak : 0;
  const tripped = input.previousTripped || drawdown <= -input.killSwitchPct;
  return { peakEquity: peak, drawdownPct: drawdown, killSwitchTripped: tripped };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
