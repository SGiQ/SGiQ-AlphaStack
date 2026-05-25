import type { CryptoBar } from '../broker/alpacaCrypto.js';

/**
 * In-memory broker for backtests.
 *
 * Design rules:
 *  - No look-ahead bias: a signal generated using bar T's close fills at
 *    bar T+1's open (the next bar after the decision).
 *  - SL/TP intra-bar triggers: when the bar following entry trades through
 *    the level, we fill at the level price. If the bar gaps past it (e.g.
 *    overnight gap), we fill at the gap open (whichever is worse for us).
 *  - Per-strategy attribution: each position knows which strategy opened it.
 *    Multiple strategies can hold the same symbol independently.
 *  - Flat fee model: feeRate × notional on every fill (default 0.15%).
 */

export interface SimPosition {
  id: string;
  strategy: string;
  symbol: string;
  qty: number;
  avgCost: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string;
}

export interface SimOrder {
  id: string;
  strategy: string;
  symbol: string;
  side: 'buy' | 'sell';
  notional?: number;
  qty?: number;
  stopLoss?: number;
  takeProfit?: number;
  reason: string;
  /** When the signal was generated (current bar's timestamp at decision time). */
  decidedAt: string;
}

export interface SimFill {
  orderId: string;
  positionId: string;
  strategy: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number;
  notional: number;
  filledAt: string;
  reason: string;
  /** How the trade closed: 'entry' | 'stop' | 'target' | 'manual' */
  exitKind?: 'stop' | 'target' | 'manual';
}

export interface ClosedTrade {
  strategy: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryAt: string;
  exitAt: string;
  pnl: number;
  pnlPct: number;
  feesPaid: number;
  exitKind: 'stop' | 'target' | 'manual';
}

export interface EquitySample {
  timestamp: string;
  equity: number;
  cash: number;
  marketValue: number;
  drawdownPct: number;
}

export interface SimBrokerConfig {
  startingCash: number;
  feeRate: number; // 0.0015 = 15 bps per fill
}

export class SimBroker {
  cash: number;
  feeRate: number;
  positions: SimPosition[] = [];
  pendingOrders: SimOrder[] = []; // queued at decision time, filled next bar
  fills: SimFill[] = [];
  closedTrades: ClosedTrade[] = [];
  equityCurve: EquitySample[] = [];

  private peakEquity: number;
  private nextId = 0;

  constructor(cfg: SimBrokerConfig) {
    this.cash = cfg.startingCash;
    this.feeRate = cfg.feeRate;
    this.peakEquity = cfg.startingCash;
  }

  private id(prefix: string): string {
    this.nextId++;
    return `${prefix}-${this.nextId}`;
  }

  /** Queue an order to fill at the next bar's open. */
  enqueueOrder(order: Omit<SimOrder, 'id'>): SimOrder {
    const full: SimOrder = { ...order, id: this.id('o') };
    this.pendingOrders.push(full);
    return full;
  }

  /** Find an open position owned by a specific strategy for a symbol. */
  positionFor(strategy: string, symbol: string): SimPosition | undefined {
    return this.positions.find((p) => p.strategy === strategy && p.symbol === symbol);
  }

  /** Drain pendingOrders at the open of `bar` for `symbol`. */
  fillPendingAtOpen(symbol: string, bar: CryptoBar): void {
    const remaining: SimOrder[] = [];
    for (const order of this.pendingOrders) {
      if (order.symbol !== symbol) { remaining.push(order); continue; }
      const fillPrice = bar.o;
      if (order.side === 'buy') {
        this.executeBuy(order, fillPrice, bar.t);
      } else {
        this.executeSell(order, fillPrice, bar.t, 'manual');
      }
    }
    this.pendingOrders = remaining;
  }

  private executeBuy(order: SimOrder, price: number, when: string): void {
    if (price <= 0) return;
    const notional = order.notional ?? (order.qty ? order.qty * price : 0);
    if (notional <= 0) return;
    if (notional > this.cash) return; // insufficient cash → silently skip

    const qty = order.qty ?? notional / price;
    const fee = notional * this.feeRate;
    if (this.cash < notional + fee) return;

    this.cash -= notional + fee;
    const position: SimPosition = {
      id: this.id('p'),
      strategy: order.strategy,
      symbol: order.symbol,
      qty,
      avgCost: price,
      stopLoss: order.stopLoss ?? null,
      takeProfit: order.takeProfit ?? null,
      openedAt: when,
    };
    this.positions.push(position);

    this.fills.push({
      orderId: order.id,
      positionId: position.id,
      strategy: order.strategy,
      symbol: order.symbol,
      side: 'buy',
      qty, price, fee, notional,
      filledAt: when,
      reason: order.reason,
    });
  }

  private executeSell(
    order: SimOrder,
    price: number,
    when: string,
    exitKind: 'stop' | 'target' | 'manual',
  ): void {
    if (price <= 0) return;
    const pos = this.positions.find((p) => p.strategy === order.strategy && p.symbol === order.symbol);
    if (!pos) return;
    const qty = Math.min(order.qty ?? pos.qty, pos.qty);
    if (qty <= 0) return;

    const proceeds = qty * price;
    const fee = proceeds * this.feeRate;
    this.cash += proceeds - fee;

    const pnl = (price - pos.avgCost) * qty - fee; // approximate (entry fee already paid)
    const pnlPct = pos.avgCost > 0 ? (price - pos.avgCost) / pos.avgCost : 0;

    this.fills.push({
      orderId: order.id,
      positionId: pos.id,
      strategy: order.strategy,
      symbol: order.symbol,
      side: 'sell',
      qty, price, fee, notional: proceeds,
      filledAt: when,
      reason: order.reason,
      exitKind,
    });

    this.closedTrades.push({
      strategy: pos.strategy,
      symbol: pos.symbol,
      qty,
      entryPrice: pos.avgCost,
      exitPrice: price,
      entryAt: pos.openedAt,
      exitAt: when,
      pnl,
      pnlPct,
      feesPaid: fee, // exit fee; entry fee accounted in cash already
      exitKind,
    });

    pos.qty -= qty;
    if (pos.qty <= 1e-12) {
      this.positions = this.positions.filter((p) => p.id !== pos.id);
    }
  }

  /**
   * Run SL/TP detection over a single bar. For every open position whose
   * symbol matches `symbol`, check whether the bar's low/high traded
   * through the level. If both fire in the same bar (rare), assume stop
   * fires first (conservative).
   */
  checkStopsAndTargets(symbol: string, bar: CryptoBar): void {
    const triggered: Array<{ pos: SimPosition; price: number; kind: 'stop' | 'target' }> = [];
    for (const pos of this.positions) {
      if (pos.symbol !== symbol) continue;
      const stop = pos.stopLoss;
      const target = pos.takeProfit;
      if (stop != null && bar.l <= stop) {
        // Stop fills at stop level, or at bar open if it gapped through
        const fillPrice = bar.o <= stop ? bar.o : stop;
        triggered.push({ pos, price: fillPrice, kind: 'stop' });
        continue;
      }
      if (target != null && bar.h >= target) {
        const fillPrice = bar.o >= target ? bar.o : target;
        triggered.push({ pos, price: fillPrice, kind: 'target' });
      }
    }
    for (const t of triggered) {
      const order: SimOrder = {
        id: this.id('o'),
        strategy: t.pos.strategy,
        symbol: t.pos.symbol,
        side: 'sell',
        qty: t.pos.qty,
        reason: t.kind === 'stop' ? 'stop-loss triggered' : 'take-profit triggered',
        decidedAt: bar.t,
      };
      this.executeSell(order, t.price, bar.t, t.kind);
    }
  }

  /**
   * Mark-to-market: compute equity using bar-close prices for the symbols
   * that have positions. Caller must supply latest close per symbol.
   */
  recordEquity(timestamp: string, lastClose: Record<string, number>): void {
    let marketValue = 0;
    for (const pos of this.positions) {
      const p = lastClose[pos.symbol] ?? pos.avgCost;
      marketValue += pos.qty * p;
    }
    const equity = this.cash + marketValue;
    if (equity > this.peakEquity) this.peakEquity = equity;
    const drawdown = this.peakEquity > 0 ? (equity - this.peakEquity) / this.peakEquity : 0;
    this.equityCurve.push({
      timestamp, equity, cash: this.cash, marketValue, drawdownPct: drawdown,
    });
  }

  equity(): number {
    const last = this.equityCurve[this.equityCurve.length - 1];
    return last ? last.equity : this.cash;
  }

  maxDrawdownPct(): number {
    let worst = 0;
    for (const s of this.equityCurve) if (s.drawdownPct < worst) worst = s.drawdownPct;
    return worst;
  }
}
