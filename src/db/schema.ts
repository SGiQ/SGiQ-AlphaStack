import {
  pgSchema,
  serial, text, timestamp, numeric, jsonb, uuid,
  index, uniqueIndex, boolean, integer,
} from 'drizzle-orm/pg-core';

// Everything AlphaStack creates lives under the `alphastack` Postgres schema.
// This keeps the bot in the same physical database as DCATradeBot (which uses
// the default `public` schema) without enum name collisions.
export const alphastack = pgSchema('alphastack');

// ---------------------------------------------------------------------------
// Enums (namespaced inside alphastack.*)
// ---------------------------------------------------------------------------
export const sideEnum = alphastack.enum('order_side', ['buy', 'sell']);
export const runModeEnum = alphastack.enum('run_mode', ['paper', 'live']);
export const strategyKindEnum = alphastack.enum('strategy_kind', [
  'momentum_breakout',
  'mean_reversion',
  'trend_following',
  'alt_speculation',
]);
export const positionStatusEnum = alphastack.enum('position_status', ['open', 'closed', 'stopped']);
export const approvalStatusEnum = alphastack.enum('approval_status', ['pending', 'approved', 'rejected', 'expired']);

// ---------------------------------------------------------------------------
// strategies — one row per strategy, drives the executor's enabled set + weights
// ---------------------------------------------------------------------------
export const strategies = alphastack.table(
  'strategies',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    kind: strategyKindEnum('kind').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    weight: numeric('weight', { precision: 5, scale: 4 }).notNull().default('0.0000'),
    params: jsonb('params').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex('strategies_name_idx').on(t.name),
  }),
);

// ---------------------------------------------------------------------------
// run_logs
// ---------------------------------------------------------------------------
export const runLogs = alphastack.table('run_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  mode: runModeEnum('mode').notNull(),
  summary: jsonb('summary').notNull(),
});

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------
export const signals = alphastack.table(
  'signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => runLogs.id, { onDelete: 'cascade' }),
    strategyId: integer('strategy_id').notNull().references(() => strategies.id),
    symbol: text('symbol').notNull(),
    side: sideEnum('side').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    suggestedNotional: numeric('suggested_notional', { precision: 18, scale: 8 }),
    suggestedQty: numeric('suggested_qty', { precision: 24, scale: 12 }),
    stopLoss: numeric('stop_loss', { precision: 18, scale: 8 }),
    takeProfit: numeric('take_profit', { precision: 18, scale: 8 }),
    reason: text('reason').notNull(),
    executedOrderId: uuid('executed_order_id'),
    skippedReason: text('skipped_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('signals_run_idx').on(t.runId),
    strategyIdx: index('signals_strategy_idx').on(t.strategyId),
  }),
);

// ---------------------------------------------------------------------------
// positions
// ---------------------------------------------------------------------------
export const positions = alphastack.table(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    strategyId: integer('strategy_id').notNull().references(() => strategies.id),
    symbol: text('symbol').notNull(),
    qty: numeric('qty', { precision: 24, scale: 12 }).notNull(),
    avgCost: numeric('avg_cost', { precision: 18, scale: 8 }).notNull(),
    stopLoss: numeric('stop_loss', { precision: 18, scale: 8 }),
    takeProfit: numeric('take_profit', { precision: 18, scale: 8 }),
    status: positionStatusEnum('status').notNull().default('open'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    realisedPnl: numeric('realised_pnl', { precision: 18, scale: 8 }),
  },
  (t) => ({
    symbolIdx: index('positions_symbol_idx').on(t.symbol),
    strategyIdx: index('positions_strategy_idx').on(t.strategyId),
    statusIdx: index('positions_status_idx').on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------
export const orders = alphastack.table(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => runLogs.id, { onDelete: 'cascade' }),
    signalId: uuid('signal_id').references(() => signals.id),
    strategyId: integer('strategy_id').notNull().references(() => strategies.id),
    brokerOrderId: text('broker_order_id'),
    clientOrderId: text('client_order_id').notNull(),
    symbol: text('symbol').notNull(),
    side: sideEnum('side').notNull(),
    notional: numeric('notional', { precision: 18, scale: 8 }),
    qty: numeric('qty', { precision: 24, scale: 12 }),
    filledAvgPrice: numeric('filled_avg_price', { precision: 18, scale: 8 }),
    status: text('status').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('orders_run_idx').on(t.runId),
    clientIdx: uniqueIndex('orders_client_idx').on(t.clientOrderId),
  }),
);

// ---------------------------------------------------------------------------
// performance_by_strategy
// ---------------------------------------------------------------------------
export const performanceByStrategy = alphastack.table(
  'performance_by_strategy',
  {
    id: serial('id').primaryKey(),
    yearMonth: text('year_month').notNull(),
    strategyId: integer('strategy_id').notNull().references(() => strategies.id),
    pnl: numeric('pnl', { precision: 18, scale: 8 }).notNull().default('0'),
    tradeCount: integer('trade_count').notNull().default(0),
    winCount: integer('win_count').notNull().default(0),
    lossCount: integer('loss_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ymStrategyIdx: uniqueIndex('perf_ym_strategy_idx').on(t.yearMonth, t.strategyId),
  }),
);

// ---------------------------------------------------------------------------
// drawdown_state
// ---------------------------------------------------------------------------
export const drawdownState = alphastack.table(
  'drawdown_state',
  {
    id: serial('id').primaryKey(),
    yearMonth: text('year_month').notNull(),
    peakEquity: numeric('peak_equity', { precision: 18, scale: 8 }).notNull(),
    currentEquity: numeric('current_equity', { precision: 18, scale: 8 }).notNull(),
    drawdownPct: numeric('drawdown_pct', { precision: 6, scale: 4 }).notNull(),
    killSwitchTripped: boolean('kill_switch_tripped').notNull().default(false),
    trippedAt: timestamp('tripped_at', { withTimezone: true }),
    resetAt: timestamp('reset_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ymIdx: uniqueIndex('drawdown_ym_idx').on(t.yearMonth),
  }),
);

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------
export const approvals = alphastack.table(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => runLogs.id, { onDelete: 'cascade' }),
    signalId: uuid('signal_id').references(() => signals.id),
    intent: jsonb('intent').notNull(),
    status: approvalStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    statusIdx: index('approvals_status_idx').on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// inferred types
// ---------------------------------------------------------------------------
export type Strategy = typeof strategies.$inferSelect;
export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type DrawdownState = typeof drawdownState.$inferSelect;
