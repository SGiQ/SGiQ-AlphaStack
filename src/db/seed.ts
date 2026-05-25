import { sql } from 'drizzle-orm';
import { getDb, closeDb } from './client.js';
import { strategies } from './schema.js';
import { loadConfig } from '../config.js';

async function main() {
  const cfg = loadConfig();
  const db = getDb();

  await db
    .insert(strategies)
    .values([
      {
        name: 'momentum_breakout_v1',
        kind: 'momentum_breakout',
        enabled: true,
        weight: cfg.WEIGHT_MOMENTUM.toFixed(4),
        params: {
          breakout_period: 20,
          volume_mult: 1.5,
          rr_min: 3,
          rsi_overbought: 80,
          timeframes: ['4Hour', '1Day'],
        },
      },
      {
        // Disabled after 2024-2025 backtest showed a 12.5% win rate and net
        // negative P&L. The "4H not in downtrend" filter is insufficient —
        // strategy buys dips that keep falling. Needs redesign before re-enabling.
        // See: backtest results in commit history.
        name: 'mean_reversion_v1',
        kind: 'mean_reversion',
        enabled: false,
        weight: cfg.WEIGHT_MEAN_REVERSION.toFixed(4),
        params: {
          rsi_oversold: 30,
          bollinger_period: 20,
          bollinger_sigma: 2,
          timeframes: ['1Hour', '4Hour'],
          disabled_reason: 'backtest 2024-2025: 12.5% win rate, net negative',
        },
      },
      {
        // Disabled after 2022-2026 (4yr) backtest: 61 trades, 32.8% win rate,
        // -$2,021 P&L. The most-traded strategy was the biggest loser — the
        // pullback-reclaim entry generates noise, not edge. Needs fundamental
        // rework (longer pullback window, multi-confirm) before re-enabling.
        name: 'trend_following_v1',
        kind: 'trend_following',
        enabled: false,
        weight: cfg.WEIGHT_TREND_FOLLOWING.toFixed(4),
        params: {
          ema_fast: 21,
          ema_mid: 55,
          ema_slow: 200,
          pullback_required: true,
          timeframes: ['1Day'],
          disabled_reason: '4yr backtest: 32.8% win rate, -$2,021 net P&L',
        },
      },
      {
        name: 'alt_speculation_v1',
        kind: 'alt_speculation',
        enabled: false, // disabled in Phase 1 — no implementation yet
        weight: cfg.WEIGHT_ALT_SPECULATION.toFixed(4),
        params: { note: 'placeholder — Phase 2' },
      },
    ])
    .onConflictDoUpdate({
      target: strategies.name,
      set: {
        // Treat the seed file as source of truth for these fields. If you
        // change enabled/weight/params here, the next deploy applies them.
        enabled: sql`excluded.enabled`,
        weight: sql`excluded.weight`,
        params: sql`excluded.params`,
        updatedAt: new Date(),
      },
    });

  console.log('strategies seeded:');
  console.log(`  momentum_breakout_v1  (weight ${cfg.WEIGHT_MOMENTUM})`);
  console.log(`  mean_reversion_v1     (weight ${cfg.WEIGHT_MEAN_REVERSION})`);
  console.log(`  trend_following_v1    (weight ${cfg.WEIGHT_TREND_FOLLOWING})`);
  console.log(`  alt_speculation_v1    (weight ${cfg.WEIGHT_ALT_SPECULATION}, disabled)`);

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
