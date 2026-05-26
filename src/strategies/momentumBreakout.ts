import type { StrategyModule, StrategySignal, MarketContext, MomentumBreakoutParams } from './types.js';
import { highestHigh, atr, rsi14, sma } from '../indicators/index.js';

/**
 * Strategy 1 — Momentum Breakout
 *
 * Setup: price breaks above N-period high on the daily timeframe with
 * volume confirmation. Skip if RSI is already overbought (avoid chasing
 * exhaustion).
 *
 * Entry rules (all must be true):
 *   - Daily close > highestHigh(daily, breakout_period - 1)  ← excludes today
 *   - Today's volume > volume_mult * SMA(daily volume, 20)
 *   - RSI-14 daily < rsi_overbought
 *   - 4H close > 4H SMA(20) (TF alignment — don't long against intraday weakness)
 *   - No existing position (this module doesn't add to winners; that's a v2 idea)
 *
 * Exit levels emitted with the signal:
 *   - stopLoss = entry_price - (ATR_14_daily * 1.5)
 *   - takeProfit = entry_price + (ATR_14_daily * 1.5 * rr_min)  ← 1:rr_min RR
 *
 * Confidence score:
 *   - 0.5 base
 *   - +0.2 if volume > 2x avg
 *   - +0.15 if RSI in 50-65 (sweet spot — strong but not overbought)
 *   - +0.15 if 4H also above its SMA(50)
 *   - clamped to [0, 1]
 */
export const momentumBreakout: StrategyModule<MomentumBreakoutParams> = {
  name: 'momentum_breakout_v1',
  requiredTimeframes: ['4Hour', '1Day'] as const,
  defaultParams: {
    breakout_period: 20,
    volume_mult: 1.5,
    rr_min: 3,
    rsi_overbought: 80,
    require_rising_200d: true,
    sma200_lookback_bars: 20,
  },

  evaluate(ctx: MarketContext, cfg: MomentumBreakoutParams): StrategySignal[] {
    const daily = ctx.bars['1Day'] ?? [];
    const h4 = ctx.bars['4Hour'] ?? [];
    if (daily.length < Math.max(cfg.breakout_period + 1, 21)) return [];
    if (h4.length < 50) return [];

    // Don't pyramid into existing positions
    if (ctx.position) return [];

    const closes = daily.map((b) => b.c);
    const volumes = daily.map((b) => b.v);
    const todayClose = closes[closes.length - 1]!;
    const todayVolume = volumes[volumes.length - 1]!;

    // Regime filter: 200-day SMA must be sloping upward.
    // Backtest evidence (2022-2026): momentum loses -$3,221 in bear regimes
    // and gains +$7,143 in bull regimes. This single filter blocks new
    // entries when the broader trend is hostile — should preserve bull-market
    // edge while suppressing bear-market losses.
    if (cfg.require_rising_200d) {
      const lookback = cfg.sma200_lookback_bars;
      if (closes.length < 200 + lookback) return [];
      const sma200Now = sma(closes, 200);
      const sma200Past = sma(closes.slice(0, -lookback), 200);
      if (!Number.isFinite(sma200Now) || !Number.isFinite(sma200Past)) return [];
      if (sma200Now <= sma200Past) return []; // 200d trending down or flat → block
    }

    // Highest high over the prior breakout_period bars, EXCLUDING today
    const priorHigh = highestHigh(
      daily.slice(0, -1).map((b) => b.h),
      cfg.breakout_period - 1,
    );
    if (!Number.isFinite(priorHigh) || todayClose <= priorHigh) return [];

    // Volume confirmation
    const avgVol = sma(volumes.slice(0, -1), 20);
    if (!Number.isFinite(avgVol) || todayVolume < cfg.volume_mult * avgVol) return [];

    // RSI filter — don't chase
    const rsi = rsi14(closes);
    if (!Number.isFinite(rsi) || rsi >= cfg.rsi_overbought) return [];

    // 4H trend alignment
    const h4Closes = h4.map((b) => b.c);
    const h4Last = h4Closes[h4Closes.length - 1]!;
    const h4Sma20 = sma(h4Closes, 20);
    if (!Number.isFinite(h4Sma20) || h4Last <= h4Sma20) return [];

    // Stop + target via ATR
    const atrValue = atr(
      daily.map((b) => ({ o: b.o, h: b.h, l: b.l, c: b.c })),
      14,
    );
    if (!Number.isFinite(atrValue) || atrValue <= 0) return [];

    const stopLoss = round2(todayClose - atrValue * 1.5);
    const takeProfit = round2(todayClose + atrValue * 1.5 * cfg.rr_min);

    // Confidence
    let confidence = 0.5;
    if (todayVolume > 2 * avgVol) confidence += 0.2;
    if (rsi >= 50 && rsi <= 65) confidence += 0.15;
    const h4Sma50 = sma(h4Closes, 50);
    if (Number.isFinite(h4Sma50) && h4Last > h4Sma50) confidence += 0.15;
    confidence = Math.min(1, Math.max(0, confidence));

    return [{
      strategy: 'momentum_breakout_v1',
      symbol: ctx.symbol,
      side: 'buy',
      confidence,
      stopLoss,
      takeProfit,
      reason:
        `breakout: close=${todayClose.toFixed(2)} > ${cfg.breakout_period}d high=${priorHigh.toFixed(2)} ` +
        `vol=${todayVolume.toFixed(0)} > ${cfg.volume_mult}x avg=${avgVol.toFixed(0)} ` +
        `rsi=${rsi.toFixed(1)} 4h>sma20 ` +
        `atr=${atrValue.toFixed(2)} sl=${stopLoss} tp=${takeProfit}`,
    }];
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
