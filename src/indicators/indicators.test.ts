import { describe, it, expect } from 'vitest';
import {
  sma, ema, emaSeries, rsi14, macd, bollinger, atr, emaStack,
  highestHigh, lowestLow, classifyTrend,
} from './index.js';

// ---------------------------------------------------------------------------
// SMA / EMA
// ---------------------------------------------------------------------------
describe('sma', () => {
  it('averages last N values', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
  });
  it('NaN when too short', () => {
    expect(Number.isNaN(sma([1, 2], 5))).toBe(true);
  });
});

describe('ema / emaSeries', () => {
  it('seeds with SMA, then smooths', () => {
    // Rising series — EMA must rise too
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    const e = ema(values, 10);
    expect(e).toBeGreaterThan(120);
    expect(e).toBeLessThan(130);
  });
  it('series length equals input length', () => {
    const values = Array.from({ length: 20 }, () => 50);
    const s = emaSeries(values, 5);
    expect(s).toHaveLength(20);
    expect(Number.isNaN(s[3])).toBe(true);
    expect(s[19]).toBeCloseTo(50, 5);
  });
});

// ---------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------
describe('rsi14', () => {
  it('returns 100 with no losses', () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi14(rising)).toBe(100);
  });
  it('Wilder canonical example ~70.5', () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28,
    ];
    const r = rsi14(closes);
    expect(r).toBeGreaterThan(70);
    expect(r).toBeLessThan(71);
  });
});

// ---------------------------------------------------------------------------
// MACD
// ---------------------------------------------------------------------------
describe('macd', () => {
  it('NaN when input too short', () => {
    expect(Number.isNaN(macd([1, 2, 3]).macd)).toBe(true);
  });
  it('positive MACD + signal on monotonic uptrend', () => {
    // Note: in a pure linear uptrend the histogram converges to ~0 in steady
    // state (MACD and its signal-EMA both stabilize at the same value).
    // We assert direction of MACD/signal only.
    const values = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5);
    const m = macd(values);
    expect(m.macd).toBeGreaterThan(0);
    expect(m.signal).toBeGreaterThan(0);
  });
  it('positive histogram on accelerating uptrend', () => {
    // Quadratic series: histogram stays positive because MACD itself keeps growing,
    // so the signal EMA lags below MACD.
    const values = Array.from({ length: 100 }, (_, i) => 100 + i * i * 0.05);
    const m = macd(values);
    expect(m.macd).toBeGreaterThan(0);
    expect(m.histogram).toBeGreaterThan(0);
  });
  it('negative MACD on monotonic downtrend', () => {
    const values = Array.from({ length: 100 }, (_, i) => 200 - i * 0.5);
    const m = macd(values);
    expect(m.macd).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bollinger
// ---------------------------------------------------------------------------
describe('bollinger', () => {
  it('middle = SMA, upper > middle > lower', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
    const b = bollinger(values);
    expect(b.middle).toBeCloseTo(sma(values, 20), 5);
    expect(b.upper).toBeGreaterThan(b.middle);
    expect(b.lower).toBeLessThan(b.middle);
    expect(b.width).toBeGreaterThan(0);
  });
  it('flat series → upper == lower == middle (zero width)', () => {
    const values = Array.from({ length: 25 }, () => 100);
    const b = bollinger(values);
    expect(b.upper).toBeCloseTo(b.lower, 5);
    expect(b.width).toBeCloseTo(0, 5);
  });
});

// ---------------------------------------------------------------------------
// ATR
// ---------------------------------------------------------------------------
describe('atr', () => {
  it('positive on a series with real range', () => {
    const ohlc = Array.from({ length: 30 }, (_, i) => ({
      o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i,
    }));
    expect(atr(ohlc)).toBeGreaterThan(0);
  });
  it('NaN when too short', () => {
    expect(Number.isNaN(atr([{ o: 1, h: 2, l: 0, c: 1 }]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EMA stack
// ---------------------------------------------------------------------------
describe('emaStack', () => {
  it('detects bull stack on rising series', () => {
    const values = Array.from({ length: 250 }, (_, i) => 100 + i * 0.4);
    const s = emaStack(values);
    expect(s.isBullStack).toBe(true);
    expect(s.isBearStack).toBe(false);
    expect(s.ema21).toBeGreaterThan(s.ema55);
    expect(s.ema55).toBeGreaterThan(s.ema200);
  });
  it('detects bear stack on falling series', () => {
    const values = Array.from({ length: 250 }, (_, i) => 500 - i * 0.4);
    const s = emaStack(values);
    expect(s.isBearStack).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Highest high / lowest low
// ---------------------------------------------------------------------------
describe('highestHigh / lowestLow', () => {
  it('returns extremes over period', () => {
    const values = [10, 12, 11, 15, 13, 14, 16, 12];
    expect(highestHigh(values, 5)).toBe(16);
    expect(lowestLow(values, 5)).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Trend classifier (lifted, smoke test)
// ---------------------------------------------------------------------------
describe('classifyTrend', () => {
  it('uptrend on a monotonic rising series', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i * 0.5);
    expect(classifyTrend(closes).regime).toBe('uptrend');
  });
});
