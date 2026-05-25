import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { runBacktest } from './replay.js';
import { printResultsTable, writeEquityCsv, writeTradesCsv } from './results.js';
import { loadConfig } from '../config.js';

// Auto-load .env if present (Node 20.12+ native, no dep)
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}

/**
 * CLI:
 *   npm run backtest -- --from 2024-01-01 --to 2026-01-01 [--cash 37500] [--symbols BTC/USD,ETH/USD] [--strategies momentum_breakout_v1,trend_following_v1]
 *
 * Outputs:
 *   - Console summary table (per-strategy)
 *   - backtest-data/results-<timestamp>.csv (equity curve)
 *   - backtest-data/trades-<timestamp>.csv (round-trips)
 */
function parseArg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

async function main() {
  const cfg = loadConfig();
  const from = parseArg('--from') ?? oneYearAgo();
  const to = parseArg('--to') ?? new Date().toISOString().slice(0, 10);
  const cash = Number(parseArg('--cash') ?? cfg.PORTFOLIO_USD);
  const symbols = (parseArg('--symbols') ?? cfg.SYMBOLS.join(',')).split(',');
  const stratsArg = parseArg('--strategies');
  const strategies = stratsArg ? stratsArg.split(',') : undefined;

  console.log(`Running backtest: ${from} -> ${to}   cash=${cash}   symbols=${symbols.join(', ')}`);
  if (strategies) console.log(`Strategies: ${strategies.join(', ')}`);

  const result = await runBacktest({
    symbols,
    start: from,
    end: to,
    startingCash: cash,
    feeRate: 0.0015,
    riskPerTradePct: cfg.RISK_PER_TRADE_PCT,
    maxConcurrent: cfg.MAX_CONCURRENT_POSITIONS,
    killSwitchPct: cfg.KILL_SWITCH_DRAWDOWN_PCT,
    strategies,
  });

  printResultsTable(result);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = resolve(process.cwd(), 'backtest-data');
  await mkdir(outDir, { recursive: true });
  await writeEquityCsv(result, resolve(outDir, `equity-${ts}.csv`));
  await writeTradesCsv(result, resolve(outDir, `trades-${ts}.csv`));
}

function oneYearAgo(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => { console.error(err); process.exit(1); });
