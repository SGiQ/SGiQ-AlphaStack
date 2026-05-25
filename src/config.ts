import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Auto-load .env if present (Node 20.12+ native, no dep). Idempotent —
// later writes to process.env override earlier ones. No-op on Railway
// where no .env file exists and env vars are injected natively.
//
// Putting this at module-load time means every entry point (cron, run:once,
// backtest, ui:dev, db:migrate, db:seed) picks up the local .env without
// each having to opt in.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envPath); } catch { /* malformed or already loaded */ }
}

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

const schema = z.object({
  // --- Alpaca ---
  ALPACA_API_KEY: z.string().min(1),
  ALPACA_SECRET_KEY: z.string().min(1),
  ALPACA_PAPER_BASE_URL: z.string().url().default('https://paper-api.alpaca.markets'),
  ALPACA_DATA_BASE_URL: z.string().url().default('https://data.alpaca.markets'),
  ALPACA_LIVE_KEY: z.string().optional(),
  ALPACA_LIVE_SECRET: z.string().optional(),
  ALPACA_LIVE_BASE_URL: z.string().url().default('https://api.alpaca.markets'),

  // --- DB ---
  // Optional in config because the backtester runs without a DB.
  // The cron worker / executor / UI require it; getDb() throws if missing
  // at the point of first use.
  DATABASE_URL: z.string().optional(),

  // --- Capital ---
  PORTFOLIO_USD: z.coerce.number().positive().default(37_500),

  // --- Risk layer ---
  RISK_PER_TRADE_PCT: z.coerce.number().positive().max(0.1).default(0.02),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive().default(5),
  ATR_STOP_MULT: z.coerce.number().positive().default(1.5),
  KILL_SWITCH_DRAWDOWN_PCT: z.coerce.number().positive().max(1).default(0.15),

  // --- Strategy weights ---
  WEIGHT_MOMENTUM: z.coerce.number().min(0).max(1).default(0.35),
  WEIGHT_MEAN_REVERSION: z.coerce.number().min(0).max(1).default(0.25),
  WEIGHT_TREND_FOLLOWING: z.coerce.number().min(0).max(1).default(0.30),
  WEIGHT_ALT_SPECULATION: z.coerce.number().min(0).max(1).default(0.05),
  WEIGHT_CASH_RESERVE: z.coerce.number().min(0).max(1).default(0.05),

  // --- Universe ---
  SYMBOLS: z.string().default('BTC/USD,ETH/USD').transform(csv),

  // --- Cron ---
  CRON_SCHEDULE: z.string().default('0 */4 * * *'),
  TZ: z.string().default('UTC'),

  // --- Safety ---
  LIVE_TRADING: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  APPROVAL_TIMEOUT_MIN: z.coerce.number().positive().default(30),
  APPROVAL_SECRET: z.string().min(16).optional(),
  NIA_WEBHOOK_URL: z.string().url().optional(),
  PUBLIC_APPROVE_BASE_URL: z.string().url().optional(),

  // --- UI ---
  UI_PORT: z.coerce.number().int().positive().default(8080),
  UI_USER: z.string().optional(),
  UI_PASS: z.string().optional(),
  UI_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;
export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  // Sanity check: weights should not exceed 1.0 (5% headroom OK to allow rounding)
  const sumWeights =
    parsed.data.WEIGHT_MOMENTUM +
    parsed.data.WEIGHT_MEAN_REVERSION +
    parsed.data.WEIGHT_TREND_FOLLOWING +
    parsed.data.WEIGHT_ALT_SPECULATION +
    parsed.data.WEIGHT_CASH_RESERVE;
  if (sumWeights > 1.05) {
    throw new Error(`Strategy weights sum to ${sumWeights.toFixed(2)} > 1.05`);
  }
  cached = parsed.data;
  return cached;
}
