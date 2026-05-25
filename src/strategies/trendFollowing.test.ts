import { describe, it, expect } from 'vitest';
import { trendFollowing } from './trendFollowing.js';
import type { MarketContext } from './types.js';
import type { CryptoBar } from '../broker/alpacaCrypto.js';

function bar(c: number, h?: number, l?: number): CryptoBar {
  return { t: new Date().toISOString(), o: c, h: h ?? c + 1, l: l ?? c - 1, c, v: 1000 };
}

function ctx(daily: CryptoBar[]): MarketContext {
  return {
    symbol: 'BTC/USD',
    bars: { '1Day': daily },
    lastPrice: daily[daily.length - 1]?.c ?? 100,
    position: null,
    account: { cash: 37500, equity: 37500, portfolioUsd: 37500 },
  };
}

describe('trendFollowing', () => {
  it('no signal when insufficient bars (<210)', () => {
    const daily = Array.from({ length: 100 }, (_, i) => bar(100 + i));
    expect(trendFollowing.evaluate(ctx(daily), trendFollowing.defaultParams)).toEqual([]);
  });

  it('no signal when stack is not bullish', () => {
    // 250 bars all roughly flat → EMA_21 ≈ EMA_55 ≈ EMA_200, no strict bull stack
    const daily = Array.from({ length: 250 }, () => bar(100));
    expect(trendFollowing.evaluate(ctx(daily), trendFollowing.defaultParams)).toEqual([]);
  });

  it('buys on bull stack + pullback + reclaim', () => {
    // 220 bars of clean uptrend; final 2 bars pull back to EMA_21 then close above it.
    // Build a long rising series, then introduce a 2-bar dip-then-reclaim near the end.
    const daily: CryptoBar[] = [];
    for (let i = 0; i < 220; i++) daily.push(bar(100 + i * 0.5));
    // Last bar before our 2-bar dip: roughly at price 100 + 219*0.5 = 209.5
    // For 220 daily bars with this slope, EMA_21 ≈ price - ~5, so ~204.5
    // We need: low ≤ EMA_21 * 1.005, and today close > EMA_21.
    daily[218] = bar(204, 209, 200);  // prev day low at 200 (touches EMA_21 area)
    daily[219] = bar(208, 210, 203);  // today low at 203 (still near), close 208 > EMA_21
    const result = trendFollowing.evaluate(ctx(daily), trendFollowing.defaultParams);
    expect(result).toHaveLength(1);
    const s = result[0]!;
    expect(s.side).toBe('buy');
    expect(s.stopLoss).toBeLessThan(208); // stop at EMA_mid which is below close
    expect(s.takeProfit).toBeGreaterThan(208);
  });

  it('no signal when pullback_required and price stays far above EMA_fast', () => {
    // Strong uptrend that NEVER pulls back to EMA_21 in the last 2 bars
    const daily = Array.from({ length: 220 }, (_, i) => bar(100 + i * 0.5));
    expect(trendFollowing.evaluate(ctx(daily), trendFollowing.defaultParams)).toEqual([]);
  });

  it('skips when already holding a position', () => {
    const daily: CryptoBar[] = [];
    for (let i = 0; i < 220; i++) daily.push(bar(100 + i * 0.5));
    daily[218] = bar(204, 209, 200);
    daily[219] = bar(208, 210, 203);
    const c = ctx(daily);
    c.position = {
      id: 'p1', symbol: 'BTC/USD', qty: 0.1, avgCost: 200,
      stopLoss: 195, takeProfit: 250, openedAt: new Date(),
    };
    expect(trendFollowing.evaluate(c, trendFollowing.defaultParams)).toEqual([]);
  });
});
