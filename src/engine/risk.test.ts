import { describe, it, expect } from 'vitest';
import { applyRiskLayer, evaluateDrawdown } from './risk.js';
import type { StrategySignal } from '../strategies/types.js';

const baseCfg = {
  portfolioUsd: 37_500,
  equity: 37_500,
  riskPerTradePct: 0.02,
  maxConcurrent: 5,
  killSwitchTripped: false,
};

function sig(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    strategy: 'test_v1', symbol: 'BTC/USD', side: 'buy',
    confidence: 0.6, stopLoss: 95, takeProfit: 130,
    reason: 'test', ...overrides,
  };
}

describe('applyRiskLayer / sizing', () => {
  it('sizes by risk-per-unit (2% of equity / SL distance)', () => {
    // equity 37,500 × 2% = $750 risk budget
    // entry 100, SL 95 → $5 risk per unit → 150 units → notional 150*100 = 15,000
    // But capped at 20% equity = 7,500
    const result = applyRiskLayer({
      signals: [sig()],
      currentPrices: { 'BTC/USD': 100 },
      openPositionCount: 0,
      cfg: baseCfg,
    });
    expect(result[0]!.status).toBe('accepted');
    expect(result[0]!.notional).toBe(7500); // hit the 20% cap
  });

  it('does not hit cap when stop is wider', () => {
    // entry 100, SL 80 → $20/unit → 37.5 units → notional 3,750 (no cap)
    const result = applyRiskLayer({
      signals: [sig({ stopLoss: 80 })],
      currentPrices: { 'BTC/USD': 100 },
      openPositionCount: 0,
      cfg: baseCfg,
    });
    expect(result[0]!.notional).toBe(3750);
  });

  it('skips when no stopLoss provided', () => {
    const result = applyRiskLayer({
      signals: [sig({ stopLoss: undefined })],
      currentPrices: { 'BTC/USD': 100 },
      openPositionCount: 0,
      cfg: baseCfg,
    });
    expect(result[0]!.status).toBe('skipped');
    expect(result[0]!.skipReason).toContain('no stopLoss');
  });

  it('skips when missing current price', () => {
    const result = applyRiskLayer({
      signals: [sig()],
      currentPrices: {},
      openPositionCount: 0,
      cfg: baseCfg,
    });
    expect(result[0]!.status).toBe('skipped');
    expect(result[0]!.skipReason).toContain('no current price');
  });
});

describe('applyRiskLayer / concurrency', () => {
  it('skips beyond maxConcurrent — highest confidence wins', () => {
    const result = applyRiskLayer({
      signals: [
        sig({ symbol: 'BTC/USD', confidence: 0.5 }),
        sig({ symbol: 'ETH/USD', confidence: 0.9 }),
        sig({ symbol: 'SOL/USD', confidence: 0.7 }),
      ],
      currentPrices: { 'BTC/USD': 100, 'ETH/USD': 100, 'SOL/USD': 100 },
      openPositionCount: 3, // already at 3 → budget = 5-3 = 2
      cfg: baseCfg,
    });
    // ETH (0.9) and SOL (0.7) should be accepted; BTC (0.5) skipped
    const eth = result.find((r) => r.signal.symbol === 'ETH/USD')!;
    const sol = result.find((r) => r.signal.symbol === 'SOL/USD')!;
    const btc = result.find((r) => r.signal.symbol === 'BTC/USD')!;
    expect(eth.status).toBe('accepted');
    expect(sol.status).toBe('accepted');
    expect(btc.status).toBe('skipped');
    expect(btc.skipReason).toContain('max concurrent');
  });
});

describe('applyRiskLayer / kill switch', () => {
  it('blocks every signal when killSwitchTripped=true', () => {
    const result = applyRiskLayer({
      signals: [sig(), sig({ symbol: 'ETH/USD' })],
      currentPrices: { 'BTC/USD': 100, 'ETH/USD': 100 },
      openPositionCount: 0,
      cfg: { ...baseCfg, killSwitchTripped: true },
    });
    expect(result.every((r) => r.status === 'skipped')).toBe(true);
    expect(result[0]!.skipReason).toContain('kill switch');
  });
});

describe('evaluateDrawdown', () => {
  it('trips when drawdown breaches the threshold', () => {
    const r = evaluateDrawdown({
      yearMonth: '2026-05',
      currentEquity: 30_000,
      previousPeak: 37_500,
      previousTripped: false,
      killSwitchPct: 0.15,
    });
    expect(r.drawdownPct).toBeCloseTo(-0.2, 3);
    expect(r.killSwitchTripped).toBe(true);
  });

  it('stays tripped once tripped (manual reset required)', () => {
    const r = evaluateDrawdown({
      yearMonth: '2026-05',
      currentEquity: 37_500,
      previousPeak: 37_500,
      previousTripped: true,
      killSwitchPct: 0.15,
    });
    expect(r.killSwitchTripped).toBe(true);
  });

  it('updates peak on new highs', () => {
    const r = evaluateDrawdown({
      yearMonth: '2026-05',
      currentEquity: 40_000,
      previousPeak: 37_500,
      previousTripped: false,
      killSwitchPct: 0.15,
    });
    expect(r.peakEquity).toBe(40_000);
    expect(r.drawdownPct).toBe(0);
  });
});
