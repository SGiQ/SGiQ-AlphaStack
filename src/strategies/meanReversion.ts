import type { StrategyModule, StrategySignal, MarketContext, MeanReversionParams } from './types.js';
import { rsi14, bollinger, atr, classifyTrend } from '../indicators/index.js';

/**
 * Strategy 2 — Mean Reversion
 *
 * Buy oversold dips that aren't in a confirmed broader downtrend (otherwise
 * we're catching a falling knife).
 *
 * Entry rules (all must be true on 1H):
 *   - RSI-14 < rsi_oversold (default 30)
 *   - 1H close < lower Bollinger Band (period=20, σ=2)
 *   - 4H trend regime is NOT 'downtrend' (uses SMA50/200 + RSI classifier
 *     from the indicators module — same logic the DCA bot uses)
 *   - No existing position for this symbol
 *
 * Exit levels:
 *   - stop  = entry - ATR(14, 1H) × 1.0  (tighter than momentum; we expect a
 *             quick bounce, so if it keeps falling we were wrong)
 *   - target = middle Bollinger (the mean we expect to revert to)
 *
 * Confidence:
 *   - 0.5 base
 *   - +0.15 if RSI < 25 (deeply oversold)
 *   - +0.15 if 4H regime is 'uptrend' (mean reversion WITH the higher TF trend)
 *   - +0.15 if Bollinger width > 0.04 (high vol → bigger snap-back potential)
 *   - clamped to [0, 1]
 */
export const meanReversion: StrategyModule<MeanReversionParams> = {
  name: 'mean_reversion_v1',
  requiredTimeframes: ['1Hour', '4Hour'] as const,
  defaultParams: {
    rsi_oversold: 30,
    bollinger_period: 20,
    bollinger_sigma: 2,
  },

  evaluate(ctx: MarketContext, cfg: MeanReversionParams): StrategySignal[] {
    const h1 = ctx.bars['1Hour'] ?? [];
    const h4 = ctx.bars['4Hour'] ?? [];

    if (h1.length < cfg.bollinger_period + 15) return [];
    if (h4.length < 200) return [];
    if (ctx.position) return [];

    const closes1h = h1.map((b) => b.c);
    const last1h = closes1h[closes1h.length - 1]!;

    const rsi = rsi14(closes1h);
    if (!Number.isFinite(rsi) || rsi >= cfg.rsi_oversold) return [];

    const bb = bollinger(closes1h, cfg.bollinger_period, cfg.bollinger_sigma);
    if (!Number.isFinite(bb.lower) || last1h >= bb.lower) return [];

    // Don't catch falling knives — block in confirmed 4H downtrends
    const closes4h = h4.map((b) => b.c);
    const trend4h = classifyTrend(closes4h);
    if (trend4h.regime === 'downtrend') return [];

    const atrValue = atr(
      h1.map((b) => ({ o: b.o, h: b.h, l: b.l, c: b.c })),
      14,
    );
    if (!Number.isFinite(atrValue) || atrValue <= 0) return [];

    const stopLoss = round2(last1h - atrValue * 1.0);
    const takeProfit = round2(bb.middle);

    // Confidence
    let confidence = 0.5;
    if (rsi < 25) confidence += 0.15;
    if (trend4h.regime === 'uptrend') confidence += 0.15;
    if (bb.width > 0.04) confidence += 0.15;
    confidence = Math.min(1, Math.max(0, confidence));

    return [{
      strategy: 'mean_reversion_v1',
      symbol: ctx.symbol,
      side: 'buy',
      confidence,
      stopLoss,
      takeProfit,
      reason:
        `mean-rev: 1h close=${last1h.toFixed(2)} < bb_lower=${bb.lower.toFixed(2)} ` +
        `rsi=${rsi.toFixed(1)} < ${cfg.rsi_oversold} ` +
        `4h_regime=${trend4h.regime} bb_mid=${bb.middle.toFixed(2)} ` +
        `atr_1h=${atrValue.toFixed(2)} sl=${stopLoss} tp=${takeProfit}`,
    }];
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
