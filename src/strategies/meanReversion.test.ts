import { describe, it, expect } from 'vitest';
import { meanReversion } from './meanReversion.js';
import type { MarketContext } from './types.js';
import type { CryptoBar } from '../broker/alpacaCrypto.js';

function bar(c: number, h?: number, l?: number, v = 1000): CryptoBar {
  return { t: new Date().toISOString(), o: c, h: h ?? c + 1, l: l ?? c - 1, c, v };
}

function ctx(h1: CryptoBar[], h4: CryptoBar[]): MarketContext {
  return {
    symbol: 'BTC/USD',
    bars: { '1Hour': h1, '4Hour': h4 },
    lastPrice: h1[h1.length - 1]?.c ?? 100,
    position: null,
    account: { cash: 37500, equity: 37500, portfolioUsd: 37500 },
  };
}

describe('meanReversion', () => {
  it('emits no signals with insufficient bars', () => {
    const result = meanReversion.evaluate(
      ctx([bar(100)], [bar(100)]),
      meanReversion.defaultParams,
    );
    expect(result).toEqual([]);
  });

  it('buys on oversold 1H dip when 4H is uptrend', () => {
    // 1H: long ranging series ~100, last few bars drop sharply → RSI < 30, below BB lower
    const h1: CryptoBar[] = [];
    for (let i = 0; i < 40; i++) h1.push(bar(100 + (i % 3))); // bouncy range
    for (let i = 0; i < 6; i++) h1.push(bar(99 - i * 1.5));   // 6 sharp down bars
    // 4H: clean uptrend over 250 bars so classifyTrend returns 'uptrend'
    const h4: CryptoBar[] = [];
    for (let i = 0; i < 250; i++) h4.push(bar(100 + i * 0.4));
    const result = meanReversion.evaluate(ctx(h1, h4), meanReversion.defaultParams);
    expect(result).toHaveLength(1);
    const s = result[0]!;
    expect(s.side).toBe('buy');
    expect(s.stopLoss).toBeLessThan(s.takeProfit!);
    expect(s.confidence).toBeGreaterThan(0.5);
  });

  it('blocks entry in confirmed 4H downtrend (no falling knives)', () => {
    const h1: CryptoBar[] = [];
    for (let i = 0; i < 40; i++) h1.push(bar(100 + (i % 3)));
    for (let i = 0; i < 6; i++) h1.push(bar(99 - i * 1.5));
    // 4H: clean downtrend
    const h4: CryptoBar[] = [];
    for (let i = 0; i < 250; i++) h4.push(bar(200 - i * 0.4));
    expect(meanReversion.evaluate(ctx(h1, h4), meanReversion.defaultParams)).toEqual([]);
  });

  it('blocks entry when already holding a position', () => {
    const h1: CryptoBar[] = [];
    for (let i = 0; i < 40; i++) h1.push(bar(100 + (i % 3)));
    for (let i = 0; i < 6; i++) h1.push(bar(99 - i * 1.5));
    const h4: CryptoBar[] = [];
    for (let i = 0; i < 250; i++) h4.push(bar(100 + i * 0.4));
    const c = ctx(h1, h4);
    c.position = {
      id: 'p1', symbol: 'BTC/USD', qty: 0.1, avgCost: 100,
      stopLoss: 95, takeProfit: 110, openedAt: new Date(),
    };
    expect(meanReversion.evaluate(c, meanReversion.defaultParams)).toEqual([]);
  });

  it('no signal when RSI is not oversold', () => {
    // Pure ranging series → RSI near 50
    const h1: CryptoBar[] = [];
    for (let i = 0; i < 50; i++) h1.push(bar(100 + (i % 3)));
    const h4: CryptoBar[] = [];
    for (let i = 0; i < 250; i++) h4.push(bar(100 + i * 0.4));
    expect(meanReversion.evaluate(ctx(h1, h4), meanReversion.defaultParams)).toEqual([]);
  });
});
