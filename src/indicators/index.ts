// All indicators are pure functions: take a numeric series (oldest first),
// return either the latest scalar or a parallel series of the same length
// (with NaN where the indicator is not yet defined).

export type Regime = 'uptrend' | 'neutral' | 'downtrend';

export interface BollingerBand {
  upper: number;
  middle: number;
  lower: number;
  width: number; // (upper - lower) / middle
}

export interface MacdReading {
  macd: number;
  signal: number;
  histogram: number;
}

// ---------------------------------------------------------------------------
// SMA + EMA
// ---------------------------------------------------------------------------

export function sma(values: number[], period: number): number {
  if (period <= 0) throw new Error('sma: period must be > 0');
  if (values.length < period) return Number.NaN;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i]!;
  return s / period;
}

/** Full EMA series (length == values.length, NaN until period values are seen). */
export function emaSeries(values: number[], period: number): number[] {
  if (period <= 0) throw new Error('emaSeries: period must be > 0');
  const k = 2 / (period + 1);
  const out: number[] = new Array(values.length).fill(Number.NaN);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i]! * k + (out[i - 1] as number) * (1 - k);
  }
  return out;
}

export function ema(values: number[], period: number): number {
  const s = emaSeries(values, period);
  return s[s.length - 1] ?? Number.NaN;
}

// ---------------------------------------------------------------------------
// RSI-14 (Wilder)
// ---------------------------------------------------------------------------

export function rsi14(values: number[], period = 14): number {
  if (values.length < period + 1) return Number.NaN;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ---------------------------------------------------------------------------
// MACD (12/26/9, EMA-based)
// ---------------------------------------------------------------------------

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdReading {
  if (values.length < slow + signalPeriod) {
    return { macd: Number.NaN, signal: Number.NaN, histogram: Number.NaN };
  }
  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  const macdSeries: number[] = values.map((_, i) => {
    const f = fastSeries[i];
    const s = slowSeries[i];
    return Number.isFinite(f) && Number.isFinite(s) ? (f as number) - (s as number) : Number.NaN;
  });
  // Strip leading NaNs before computing signal EMA
  const firstFinite = macdSeries.findIndex((v) => Number.isFinite(v));
  if (firstFinite < 0) return { macd: Number.NaN, signal: Number.NaN, histogram: Number.NaN };
  const trimmed = macdSeries.slice(firstFinite);
  const signalSeries = emaSeries(trimmed, signalPeriod);
  const macdValue = trimmed[trimmed.length - 1]!;
  const signalValue = signalSeries[signalSeries.length - 1]!;
  return { macd: macdValue, signal: signalValue, histogram: macdValue - signalValue };
}

// ---------------------------------------------------------------------------
// Bollinger Bands (20, 2σ)
// ---------------------------------------------------------------------------

export function bollinger(values: number[], period = 20, mult = 2): BollingerBand {
  if (values.length < period) {
    return { upper: Number.NaN, middle: Number.NaN, lower: Number.NaN, width: Number.NaN };
  }
  const slice = values.slice(values.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = mean + mult * stdDev;
  const lower = mean - mult * stdDev;
  return { upper, middle: mean, lower, width: (upper - lower) / mean };
}

// ---------------------------------------------------------------------------
// ATR-14 (Wilder)
// ---------------------------------------------------------------------------

export interface OHLC { o: number; h: number; l: number; c: number; }

export function atr(ohlc: OHLC[], period = 14): number {
  if (ohlc.length < period + 1) return Number.NaN;
  const trs: number[] = [];
  for (let i = 1; i < ohlc.length; i++) {
    const cur = ohlc[i]!;
    const prev = ohlc[i - 1]!;
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c),
    );
    trs.push(tr);
  }
  // Wilder smoothing
  let avg = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    avg = (avg * (period - 1) + trs[i]!) / period;
  }
  return avg;
}

// ---------------------------------------------------------------------------
// Trend regime classifier (lifted from DCATradeBot, useful as a meta filter)
// ---------------------------------------------------------------------------

export interface TrendReading {
  regime: Regime;
  price: number;
  sma50: number;
  sma200: number;
  rsi: number;
}

export function classifyTrend(closes: number[]): TrendReading {
  const price = closes[closes.length - 1] ?? Number.NaN;
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const r = rsi14(closes, 14);
  let regime: Regime = 'neutral';
  if (Number.isFinite(s50) && Number.isFinite(s200) && Number.isFinite(r) && Number.isFinite(price)) {
    if (price > s50 && s50 > s200 && r > 50) regime = 'uptrend';
    else if (price < s50 && s50 < s200 && r < 50) regime = 'downtrend';
  }
  return { regime, price, sma50: s50, sma200: s200, rsi: r };
}

// ---------------------------------------------------------------------------
// EMA stack helper (Strategy 3 uses this directly)
// ---------------------------------------------------------------------------

export interface EmaStack {
  ema21: number;
  ema55: number;
  ema200: number;
  isBullStack: boolean;  // 21 > 55 > 200
  isBearStack: boolean;  // 21 < 55 < 200
}

export function emaStack(values: number[]): EmaStack {
  const e21 = ema(values, 21);
  const e55 = ema(values, 55);
  const e200 = ema(values, 200);
  const isBullStack = Number.isFinite(e21) && Number.isFinite(e55) && Number.isFinite(e200) && e21 > e55 && e55 > e200;
  const isBearStack = Number.isFinite(e21) && Number.isFinite(e55) && Number.isFinite(e200) && e21 < e55 && e55 < e200;
  return { ema21: e21, ema55: e55, ema200: e200, isBullStack, isBearStack };
}

// ---------------------------------------------------------------------------
// Highest high / lowest low over period (breakout detection)
// ---------------------------------------------------------------------------

export function highestHigh(values: number[], period: number): number {
  if (values.length < period) return Number.NaN;
  let max = -Infinity;
  for (let i = values.length - period; i < values.length; i++) {
    if (values[i]! > max) max = values[i]!;
  }
  return max;
}

export function lowestLow(values: number[], period: number): number {
  if (values.length < period) return Number.NaN;
  let min = Infinity;
  for (let i = values.length - period; i < values.length; i++) {
    if (values[i]! < min) min = values[i]!;
  }
  return min;
}
