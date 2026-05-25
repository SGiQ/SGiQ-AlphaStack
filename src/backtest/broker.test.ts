import { describe, it, expect } from 'vitest';
import { SimBroker } from './broker.js';
import type { CryptoBar } from '../broker/alpacaCrypto.js';

const bar = (o: number, h: number, l: number, c: number, t = '2026-01-01T00:00:00Z'): CryptoBar =>
  ({ o, h, l, c, v: 1000, t });

const cfg = { startingCash: 10_000, feeRate: 0.0015 };

describe('SimBroker / fills', () => {
  it('queues a buy and fills it at next bar open', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({
      strategy: 'momentum_breakout_v1', symbol: 'BTC/USD', side: 'buy',
      notional: 1000, stopLoss: 90, takeProfit: 130,
      reason: 'test', decidedAt: '2026-01-01T00:00:00Z',
    });
    b.fillPendingAtOpen('BTC/USD', bar(100, 105, 99, 102, '2026-01-02T00:00:00Z'));
    expect(b.positions).toHaveLength(1);
    const p = b.positions[0]!;
    expect(p.avgCost).toBe(100);
    expect(p.qty).toBeCloseTo(10, 5);
    expect(b.cash).toBeCloseTo(10_000 - 1000 - 1.5, 2); // notional + fee
  });

  it('refuses a buy that exceeds available cash', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({
      strategy: 's', symbol: 'BTC/USD', side: 'buy', notional: 20_000,
      reason: 't', decidedAt: '2026-01-01T00:00:00Z',
    });
    b.fillPendingAtOpen('BTC/USD', bar(100, 100, 100, 100));
    expect(b.positions).toHaveLength(0);
    expect(b.cash).toBe(10_000);
  });
});

describe('SimBroker / stop-loss + take-profit', () => {
  it('triggers stop when bar low pierces stopLoss', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({
      strategy: 's', symbol: 'BTC/USD', side: 'buy', notional: 1000,
      stopLoss: 90, takeProfit: 130,
      reason: 't', decidedAt: '2026-01-01T00:00:00Z',
    });
    b.fillPendingAtOpen('BTC/USD', bar(100, 105, 99, 102, '2026-01-02T00:00:00Z'));
    // Next bar: prints a low of 88 → stop fires at 90
    b.checkStopsAndTargets('BTC/USD', bar(99, 100, 88, 95, '2026-01-03T00:00:00Z'));
    expect(b.positions).toHaveLength(0);
    expect(b.closedTrades).toHaveLength(1);
    expect(b.closedTrades[0]!.exitKind).toBe('stop');
    expect(b.closedTrades[0]!.exitPrice).toBe(90);
  });

  it('triggers target when bar high pierces takeProfit', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({
      strategy: 's', symbol: 'BTC/USD', side: 'buy', notional: 1000,
      stopLoss: 90, takeProfit: 130,
      reason: 't', decidedAt: '2026-01-01T00:00:00Z',
    });
    b.fillPendingAtOpen('BTC/USD', bar(100, 105, 99, 102, '2026-01-02T00:00:00Z'));
    b.checkStopsAndTargets('BTC/USD', bar(105, 135, 104, 132, '2026-01-03T00:00:00Z'));
    expect(b.positions).toHaveLength(0);
    expect(b.closedTrades[0]!.exitKind).toBe('target');
    expect(b.closedTrades[0]!.exitPrice).toBe(130);
  });

  it('fills at gap-through price when bar opens past the stop', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({
      strategy: 's', symbol: 'BTC/USD', side: 'buy', notional: 1000,
      stopLoss: 90, takeProfit: 130,
      reason: 't', decidedAt: '2026-01-01T00:00:00Z',
    });
    b.fillPendingAtOpen('BTC/USD', bar(100, 105, 99, 102, '2026-01-02T00:00:00Z'));
    // Gap-down open at 85 (worse than the stop at 90)
    b.checkStopsAndTargets('BTC/USD', bar(85, 88, 80, 86, '2026-01-03T00:00:00Z'));
    expect(b.closedTrades[0]!.exitPrice).toBe(85); // filled at the worse open
  });
});

describe('SimBroker / equity tracking', () => {
  it('marks to market and tracks drawdown', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({
      strategy: 's', symbol: 'BTC/USD', side: 'buy', notional: 1000,
      stopLoss: 80, takeProfit: 200,
      reason: 't', decidedAt: '2026-01-01T00:00:00Z',
    });
    b.fillPendingAtOpen('BTC/USD', bar(100, 105, 99, 102, '2026-01-02T00:00:00Z'));
    // Mark at $110: equity = 8998.5 cash + 10 × 110 = $10,098.5
    b.recordEquity('2026-01-02T00:00:00Z', { 'BTC/USD': 110 });
    expect(b.equity()).toBeCloseTo(10_098.5, 2);
    // Mark at $90: equity = 8998.5 + 10 × 90 = 9898.5
    b.recordEquity('2026-01-03T00:00:00Z', { 'BTC/USD': 90 });
    // Drawdown = (9898.5 - 10098.5)/10098.5 ≈ -1.98%
    expect(b.maxDrawdownPct()).toBeLessThan(-0.015);
    expect(b.maxDrawdownPct()).toBeGreaterThan(-0.025);
  });
});

describe('SimBroker / per-strategy attribution', () => {
  it('allows two strategies to hold the same symbol independently', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({
      strategy: 'momentum_breakout_v1', symbol: 'BTC/USD', side: 'buy',
      notional: 500, reason: 't', decidedAt: '2026-01-01T00:00:00Z',
    });
    b.enqueueOrder({
      strategy: 'trend_following_v1', symbol: 'BTC/USD', side: 'buy',
      notional: 500, reason: 't', decidedAt: '2026-01-01T00:00:00Z',
    });
    b.fillPendingAtOpen('BTC/USD', bar(100, 100, 100, 100, '2026-01-02T00:00:00Z'));
    expect(b.positions).toHaveLength(2);
    expect(b.positionFor('momentum_breakout_v1', 'BTC/USD')).toBeDefined();
    expect(b.positionFor('trend_following_v1', 'BTC/USD')).toBeDefined();
  });
});
