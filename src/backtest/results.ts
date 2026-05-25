import { writeFile } from 'node:fs/promises';
import type { BacktestResult } from './replay.js';

export function printResultsTable(r: BacktestResult, momentumOnly: BacktestResult | null = null): void {
  const fmtUsd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (n: number) => (n * 100).toFixed(2) + '%';
  const fmtPctSigned = (n: number) => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
  const col = (s: string) => s.padStart(12);

  console.log('');
  console.log('════════════════════════════════════════════════════════════════════════════════════════');
  console.log(`Backtest: ${r.config.symbols.join(', ')}`);
  console.log(`Range:     ${r.config.start.slice(0, 10)} -> ${r.config.end.slice(0, 10)}`);
  console.log(`Starting:  ${fmtUsd(r.config.startingCash)}`);
  console.log('');

  // Build header dynamically — include momentum-only column when present
  const headers = ['Strategy'];
  if (momentumOnly) headers.push('Momentum');
  headers.push('BTC HODL', 'ETH HODL', '60/40 HODL');
  console.log('         ' + headers.map(col).join('  '));

  const finalRow = [col(fmtUsd(r.finalEquity))];
  if (momentumOnly) finalRow.push(col(fmtUsd(momentumOnly.finalEquity)));
  finalRow.push(
    col(fmtUsd(r.benchmarks.btcHodl.finalValue)),
    col(fmtUsd(r.benchmarks.ethHodl.finalValue)),
    col(fmtUsd(r.benchmarks.portfolio6040.finalValue)),
  );
  console.log('Final:   ' + finalRow.join('  '));

  const returnRow = [col(fmtPctSigned(r.totalReturnPct))];
  if (momentumOnly) returnRow.push(col(fmtPctSigned(momentumOnly.totalReturnPct)));
  returnRow.push(
    col(fmtPctSigned(r.benchmarks.btcHodl.returnPct)),
    col(fmtPctSigned(r.benchmarks.ethHodl.returnPct)),
    col(fmtPctSigned(r.benchmarks.portfolio6040.returnPct)),
  );
  console.log('Return:  ' + returnRow.join('  '));

  const ddRow = [col(fmtPct(r.maxDrawdownPct))];
  if (momentumOnly) ddRow.push(col(fmtPct(momentumOnly.maxDrawdownPct)));
  ddRow.push(
    col(fmtPct(r.benchmarks.btcHodl.maxDdPct)),
    col(fmtPct(r.benchmarks.ethHodl.maxDdPct)),
    col(fmtPct(r.benchmarks.portfolio6040.maxDdPct)),
  );
  console.log('Max DD:  ' + ddRow.join('  '));
  console.log('');
  console.log(`Total trades: ${r.totalTrades}`);
  if (r.killSwitchTripped) {
    console.log(`KILL SWITCH: tripped at ${r.killSwitchFirstTrippedAt} (latched for that month)`);
  } else {
    console.log(`Kill switch: never tripped`);
  }
  console.log('────────────────────────────────────────────────────────────────────────');
  console.log('Strategy                  Trades   Wins   Losses  Win%    Gross P&L');
  console.log('────────────────────────────────────────────────────────────────────────');
  for (const s of r.byStrategy) {
    const name = s.name.padEnd(25);
    const tr = String(s.trades).padStart(6);
    const w = String(s.wins).padStart(6);
    const l = String(s.losses).padStart(7);
    const wr = (s.winRate * 100).toFixed(1).padStart(5) + '%';
    const pnl = fmtUsd(s.grossPnl).padStart(12);
    console.log(`${name} ${tr} ${w} ${l}   ${wr}  ${pnl}`);
  }
  console.log('════════════════════════════════════════════════════════════════════════════════════════');

  // Verdict line — strategy vs benchmark
  const beatBtc = r.totalReturnPct > r.benchmarks.btcHodl.returnPct;
  const beat6040 = r.totalReturnPct > r.benchmarks.portfolio6040.returnPct;
  const gap6040Pct = ((r.totalReturnPct - r.benchmarks.portfolio6040.returnPct) * 100).toFixed(2);
  if (beatBtc && beat6040) {
    console.log(`Verdict: strategy beat both BTC HODL and 60/40 HODL (gap to 60/40: ${gap6040Pct} pts)`);
  } else if (!beatBtc && !beat6040) {
    console.log(`Verdict: strategy UNDERPERFORMED 60/40 HODL by ${Math.abs(Number(gap6040Pct))} pts. Active engine is value-destroying over this window.`);
  } else {
    console.log(`Verdict: mixed — strategy vs 60/40 gap = ${gap6040Pct} pts`);
  }
  if (momentumOnly) {
    const momGap = ((momentumOnly.totalReturnPct - r.benchmarks.portfolio6040.returnPct) * 100).toFixed(2);
    const momVsAll = ((momentumOnly.totalReturnPct - r.totalReturnPct) * 100).toFixed(2);
    console.log(`         momentum-only vs 60/40 HODL: ${momGap} pts; vs full strategy: ${momVsAll} pts`);
  }
  console.log('');
}

export async function writeEquityCsv(r: BacktestResult, path: string): Promise<void> {
  const lines = ['timestamp,equity,drawdown_pct,btc_hodl,eth_hodl,portfolio_6040'];
  for (const sample of r.equityCurve) {
    lines.push([
      sample.t,
      sample.equity.toFixed(2),
      (sample.drawdown * 100).toFixed(4),
      sample.btcHodl.toFixed(2),
      sample.ethHodl.toFixed(2),
      sample.portfolio6040.toFixed(2),
    ].join(','));
  }
  await writeFile(path, lines.join('\n'));
  console.log(`equity curve -> ${path} (${r.equityCurve.length} samples)`);
}

export async function writeTradesCsv(r: BacktestResult, path: string): Promise<void> {
  const lines = ['strategy,symbol,entry_at,exit_at,entry,exit,qty,pnl,pnl_pct,exit_kind'];
  for (const t of r.closedTrades) {
    lines.push([
      t.strategy, t.symbol, t.entryAt, t.exitAt,
      t.entryPrice.toFixed(4), t.exitPrice.toFixed(4),
      t.qty.toFixed(8), t.pnl.toFixed(2),
      (t.pnlPct * 100).toFixed(4) + '%',
      t.exitKind,
    ].join(','));
  }
  await writeFile(path, lines.join('\n'));
  console.log(`trades -> ${path} (${r.closedTrades.length} trades)`);
}
