import { describe, it, expect } from 'vitest';
import { momentumBreakout } from './momentumBreakout.js';
import type { MarketContext } from './types.js';
import type { CryptoBar } from '../broker/alpacaCrypto.js';

function makeBars(n: number, fn: (i: number) => Partial<CryptoBar>): CryptoBar[] {
  return Array.from({ length: n }, (_, i) => ({
    t: new Date(2026, 0, i + 1).toISOString(),
    o: 100, h: 101, l: 99, c: 100, v: 1000,
    ...fn(i),
  }));
}

function ctx(daily: CryptoBar[], h4: CryptoBar[]): MarketContext {
  const lastClose = daily[daily.length - 1]?.c ?? 100;
  return {
    symbol: 'BTC/USD',
    bars: { '1Day': daily, '4Hour': h4 },
    lastPrice: lastClose,
    position: null,
    account: { cash: 37500, equity: 37500, portfolioUsd: 37500 },
  };
}

describe('momentumBreakout', () => {
  it('emits no signals when insufficient bars', () => {
    const result = momentumBreakout.evaluate(
      ctx(makeBars(10, () => ({})), makeBars(50, () => ({}))),
      momentumBreakout.defaultParams,
    );
    expect(result).toEqual([]);
  });

  it('blocks all entries when 200-day SMA is falling (regime filter)', () => {
    // 230 daily bars: long downtrend ending in a breakout. The breakout
    // setup would otherwise pass (volume, RSI), but the 200-day slope is
    // negative — regime filter must block.
    const daily = makeBars(230, (i) => {
      // Slope: linear decline from $200 to $100 across all 230 bars
      const c = 200 - (i * 100 / 230);
      if (i < 229) return { h: c + 1, l: c - 1, o: c, c, v: 1000 };
      return { h: c + 5, l: c - 1, o: c, c: c + 4, v: 2500 }; // breakout day
    });
    const h4 = makeBars(60, (i) => ({ c: 50 + i * 0.3 }));
    const result = momentumBreakout.evaluate(
      ctx(daily, h4),
      momentumBreakout.defaultParams,
    );
    expect(result).toEqual([]);
  });

  it('disabling the regime filter allows entries in a bear', () => {
    // Same declining 230-bar fixture as the regime-block test, but the final
    // bar spikes hard (close 115 vs the ~110 prior high) so the breakout
    // check passes when the regime filter is disabled.
    const daily = makeBars(230, (i) => {
      const c = 200 - (i * 100 / 230);
      if (i < 229) return { h: c + 1, l: c - 1, o: c, c, v: 1000 };
      // Strong spike day: close at 115 — clearly above prior 20-day high
      return { h: 120, l: 99, o: 100, c: 115, v: 2500 };
    });
    const h4 = makeBars(60, (i) => ({ c: 50 + i * 0.3, h: 51 + i * 0.3, l: 49 + i * 0.3 }));
    const result = momentumBreakout.evaluate(
      ctx(daily, h4),
      { ...momentumBreakout.defaultParams, require_rising_200d: false },
    );
    expect(result.length).toBe(1);
  });

  it('emits a buy on a clean breakout with volume + ATR + RSI alignment', () => {
    // 21 daily bars: first 20 trade in 100-110 range with normal volume;
    // bar 21 breaks above 110 with 2x volume.
    const daily = makeBars(30, (i) => {
      if (i < 29) return { h: 110, l: 100, o: 105, c: 105 + (i % 3), v: 1000 };
      return { h: 115, l: 109, o: 110, c: 114, v: 2500 }; // breakout day
    });
    // 4H bars: rising, last close above SMA(20)
    const h4 = makeBars(60, (i) => ({ c: 100 + i * 0.3, h: 100 + i * 0.3 + 1, l: 100 + i * 0.3 - 1 }));
    // Disable regime filter — this test uses only 30 bars, regime filter needs 220+
    const result = momentumBreakout.evaluate(ctx(daily, h4), { ...momentumBreakout.defaultParams, require_rising_200d: false });
    expect(result).toHaveLength(1);
    const s = result[0]!;
    expect(s.side).toBe('buy');
    expect(s.stopLoss).toBeLessThan(s.takeProfit!);
    expect(s.takeProfit).toBeGreaterThan(114); // above entry
    expect(s.confidence).toBeGreaterThan(0.5);
  });

  it('skips when volume is too low (no confirmation)', () => {
    const daily = makeBars(30, (i) => {
      if (i < 29) return { h: 110, l: 100, c: 105, v: 1000 };
      return { h: 115, l: 109, c: 114, v: 1100 }; // breakout but volume only 1.1x
    });
    const h4 = makeBars(60, (i) => ({ c: 100 + i * 0.3 }));
    expect(momentumBreakout.evaluate(ctx(daily, h4), { ...momentumBreakout.defaultParams, require_rising_200d: false })).toEqual([]);
  });

  it('skips when already holding a position (no pyramiding)', () => {
    const daily = makeBars(30, (i) => {
      if (i < 29) return { h: 110, l: 100, c: 105, v: 1000 };
      return { h: 115, l: 109, c: 114, v: 2500 };
    });
    const h4 = makeBars(60, (i) => ({ c: 100 + i * 0.3 }));
    const c = ctx(daily, h4);
    c.position = {
      id: 'p1', symbol: 'BTC/USD', qty: 0.1, avgCost: 100,
      stopLoss: 95, takeProfit: 130, openedAt: new Date(),
    };
    expect(momentumBreakout.evaluate(c, { ...momentumBreakout.defaultParams, require_rising_200d: false })).toEqual([]);
  });

  it('skips when RSI is overbought', () => {
    // Series that creates RSI > 80
    const daily = makeBars(30, (i) => {
      // Hard upward trend → RSI saturates near 100
      return { h: 100 + i + 1, l: 100 + i - 1, o: 100 + i, c: 100 + i + 0.5, v: 1000 };
    });
    // Force the last bar to be a "breakout" (high vol + above prior high)
    const last = daily[daily.length - 1]!;
    last.v = 2500;
    const h4 = makeBars(60, (i) => ({ c: 100 + i * 0.3 }));
    // Disable regime filter — this test uses only 30 bars, regime filter needs 220+
    const result = momentumBreakout.evaluate(ctx(daily, h4), { ...momentumBreakout.defaultParams, require_rising_200d: false });
    expect(result).toEqual([]); // RSI filter blocks it
  });
});
