import type { StrategyModule, StrategySignal, MarketContext, TrendFollowingParams } from './types.js';
import { ema, emaStack, atr } from '../indicators/index.js';

/**
 * Strategy 3 — Trend Following
 *
 * The "buy the dip in a confirmed bull stack" play. Designed to catch
 * sustained uptrends and ride them while the trend remains intact.
 *
 * Entry rules (daily timeframe, all required):
 *   - EMA stack is bullish: EMA_fast > EMA_mid > EMA_slow (e.g. 21 > 55 > 200)
 *   - If pullback_required: yesterday's low touched EMA_fast, today closes
 *     back above EMA_fast (a "reclaim")
 *   - No existing position
 *
 * Exit levels:
 *   - stop  = EMA_mid (a break of EMA_mid signals trend exhaustion)
 *   - target = trailing — we use ATR × 3 as a notional target, but in practice
 *     the executor should re-evaluate exit each daily run (exit when stack
 *     breaks). This signal carries the initial level.
 *
 * Confidence:
 *   - 0.5 base
 *   - +0.2 if EMA_fast is rising (vs 5 days ago)
 *   - +0.15 if price is < 5% above EMA_fast (still close to the line, not extended)
 *   - +0.15 if EMA_mid > EMA_slow by > 5% (strong stack separation)
 */
export const trendFollowing: StrategyModule<TrendFollowingParams> = {
  name: 'trend_following_v1',
  requiredTimeframes: ['1Day'] as const,
  defaultParams: {
    ema_fast: 21,
    ema_mid: 55,
    ema_slow: 200,
    pullback_required: true,
  },

  evaluate(ctx: MarketContext, cfg: TrendFollowingParams): StrategySignal[] {
    const daily = ctx.bars['1Day'] ?? [];
    if (daily.length < cfg.ema_slow + 5) return [];
    if (ctx.position) return [];

    const closes = daily.map((b) => b.c);

    // EMA stack must be bullish using the configured periods. emaStack uses
    // 21/55/200 hardcoded; for full parity we compute the configured ones
    // directly here.
    const eFast = ema(closes, cfg.ema_fast);
    const eMid = ema(closes, cfg.ema_mid);
    const eSlow = ema(closes, cfg.ema_slow);
    if (!Number.isFinite(eFast) || !Number.isFinite(eMid) || !Number.isFinite(eSlow)) return [];
    if (!(eFast > eMid && eMid > eSlow)) return [];

    const lastClose = closes[closes.length - 1]!;
    const lastLow = daily[daily.length - 1]!.l;
    const prevLow = daily[daily.length - 2]?.l ?? lastLow;

    // Pullback test: in the last 2 bars the low touched EMA_fast and we closed
    // back above it today. This is a soft "reclaim" pattern.
    if (cfg.pullback_required) {
      const touchedFast = Math.min(prevLow, lastLow) <= eFast * 1.005; // within 0.5%
      if (!touchedFast) return [];
      if (lastClose <= eFast) return [];
    }

    const atrValue = atr(
      daily.map((b) => ({ o: b.o, h: b.h, l: b.l, c: b.c })),
      14,
    );
    if (!Number.isFinite(atrValue) || atrValue <= 0) return [];

    const stopLoss = round2(eMid);
    const takeProfit = round2(lastClose + atrValue * 3);

    // Confidence
    let confidence = 0.5;
    const eFast5BarsAgo = ema(closes.slice(0, -5), cfg.ema_fast);
    if (Number.isFinite(eFast5BarsAgo) && eFast > eFast5BarsAgo) confidence += 0.2;
    if (lastClose / eFast < 1.05) confidence += 0.15;
    if (eMid / eSlow > 1.05) confidence += 0.15;
    confidence = Math.min(1, Math.max(0, confidence));

    // Use a meta emaStack call only for clean log output
    const stack = emaStack(closes);

    return [{
      strategy: 'trend_following_v1',
      symbol: ctx.symbol,
      side: 'buy',
      confidence,
      stopLoss,
      takeProfit,
      reason:
        `trend-follow: bull stack ${cfg.ema_fast}>${cfg.ema_mid}>${cfg.ema_slow} ` +
        `(${stack.ema21.toFixed(2)}>${stack.ema55.toFixed(2)}>${stack.ema200.toFixed(2)}) ` +
        `close=${lastClose.toFixed(2)} pullback_to_emaFast=${eFast.toFixed(2)} ` +
        `sl=${stopLoss}(emaMid) tp=${takeProfit}(close+3*atr)`,
    }];
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
