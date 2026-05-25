import cron from 'node-cron';
import { loadConfig } from '../config.js';
import { runOnce } from '../engine/executor.js';

const cfg = loadConfig();

console.log(`[cron] AlphaStack scheduled: "${cfg.CRON_SCHEDULE}" tz=${cfg.TZ} live=${cfg.LIVE_TRADING}`);
console.log(`[cron] portfolio=$${cfg.PORTFOLIO_USD} risk/trade=${(cfg.RISK_PER_TRADE_PCT * 100).toFixed(1)}% max_concurrent=${cfg.MAX_CONCURRENT_POSITIONS}`);

cron.schedule(
  cfg.CRON_SCHEDULE,
  async () => {
    const start = Date.now();
    console.log(`[cron] tick @ ${new Date().toISOString()}`);
    try {
      const result = await runOnce();
      console.log(
        `[cron] done runId=${result.runId} ` +
        `signals=${result.totalSignals} accepted=${result.accepted} skipped=${result.skipped} ` +
        `kill_switch=${result.killSwitchTripped} (${Date.now() - start}ms)`,
      );
    } catch (err) {
      console.error('[cron] run failed:', err);
    }
  },
  { timezone: cfg.TZ },
);

process.on('SIGINT', () => {
  console.log('[cron] shutting down');
  process.exit(0);
});
