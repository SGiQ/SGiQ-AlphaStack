import { writeFile } from 'node:fs/promises';
import type { BacktestResult } from './replay.js';

export function printResultsTable(r: BacktestResult): void {
  const fmtUsd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (n: number) => (n * 100).toFixed(2) + '%';

  console.log('');
  console.log('════════════════════════════════════════════════════════════════════════');
  console.log(`Backtest: ${r.config.symbols.join(', ')}`);
  console.log(`Range:     ${r.config.start.slice(0, 10)} -> ${r.config.end.slice(0, 10)}`);
  console.log(`Starting:  ${fmtUsd(r.config.startingCash)}`);
  console.log(`Final:     ${fmtUsd(r.finalEquity)}`);
  console.log(`Return:    ${fmtPct(r.totalReturnPct)}   Max DD: ${fmtPct(r.maxDrawdownPct)}`);
  console.log(`Trades:    ${r.totalTrades}`);
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
  console.log('════════════════════════════════════════════════════════════════════════');
  console.log('');
}

export async function writeEquityCsv(r: BacktestResult, path: string): Promise<void> {
  const lines = ['timestamp,equity,drawdown_pct'];
  for (const sample of r.equityCurve) {
    lines.push(`${sample.t},${sample.equity.toFixed(2)},${(sample.drawdown * 100).toFixed(4)}`);
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
