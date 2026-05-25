import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { getDb } from '../db/client.js';
import {
  drawdownState, orders, positions, runLogs, signals, strategies,
} from '../db/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DASHBOARD_HTML = readFileSync(resolve(__dirname, 'dashboard.html'), 'utf8');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  const payload = contentType === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="alphastack"' });
  res.end('unauthorized');
}

function checkBasicAuth(req: IncomingMessage, user: string, pass: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const su = decoded.slice(0, idx);
  const sp = decoded.slice(idx + 1);
  try {
    const um = timingSafeEqual(Buffer.from(user, 'utf8'), Buffer.from(su, 'utf8'));
    const pm = timingSafeEqual(Buffer.from(pass, 'utf8'), Buffer.from(sp, 'utf8'));
    return um && pm;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
async function apiStrategies(): Promise<unknown> {
  const db = getDb();
  return db.select().from(strategies).orderBy(strategies.id);
}

async function apiRuns(): Promise<unknown> {
  const db = getDb();
  return db.select().from(runLogs).orderBy(desc(runLogs.ranAt)).limit(30);
}

async function apiSignals(): Promise<unknown> {
  const db = getDb();
  return db
    .select({
      id: signals.id, runId: signals.runId, symbol: signals.symbol, side: signals.side,
      confidence: signals.confidence, suggestedNotional: signals.suggestedNotional,
      stopLoss: signals.stopLoss, takeProfit: signals.takeProfit,
      reason: signals.reason, skippedReason: signals.skippedReason,
      createdAt: signals.createdAt,
      strategyName: strategies.name, strategyKind: strategies.kind,
    })
    .from(signals)
    .leftJoin(strategies, eq(signals.strategyId, strategies.id))
    .orderBy(desc(signals.createdAt))
    .limit(100);
}

async function apiOrders(): Promise<unknown> {
  const db = getDb();
  return db
    .select({
      id: orders.id, brokerOrderId: orders.brokerOrderId, clientOrderId: orders.clientOrderId,
      symbol: orders.symbol, side: orders.side, notional: orders.notional, qty: orders.qty,
      filledAvgPrice: orders.filledAvgPrice, status: orders.status, reason: orders.reason,
      createdAt: orders.createdAt,
      strategyName: strategies.name,
    })
    .from(orders)
    .leftJoin(strategies, eq(orders.strategyId, strategies.id))
    .orderBy(desc(orders.createdAt))
    .limit(100);
}

async function apiPositions(): Promise<unknown> {
  const db = getDb();
  return db
    .select({
      id: positions.id, symbol: positions.symbol, qty: positions.qty,
      avgCost: positions.avgCost, stopLoss: positions.stopLoss, takeProfit: positions.takeProfit,
      status: positions.status, openedAt: positions.openedAt, closedAt: positions.closedAt,
      realisedPnl: positions.realisedPnl,
      strategyName: strategies.name,
    })
    .from(positions)
    .leftJoin(strategies, eq(positions.strategyId, strategies.id))
    .orderBy(desc(positions.openedAt))
    .limit(100);
}

async function apiDrawdown(): Promise<unknown> {
  const db = getDb();
  // Current month's drawdown row + recent equity samples (for charting)
  const rows = await db
    .select()
    .from(drawdownState)
    .orderBy(desc(drawdownState.updatedAt))
    .limit(60);
  return rows;
}

async function apiSummary(): Promise<unknown> {
  // Fast aggregates for the KPI row
  const db = getDb();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [{ count: signalsLast24h } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(signals)
    .where(gte(signals.createdAt, oneDayAgo));

  const [{ count: acceptedLast24h } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(signals)
    .where(and(gte(signals.createdAt, oneDayAgo), sql`${signals.skippedReason} IS NULL`));

  const [{ count: openPositions } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(positions)
    .where(eq(positions.status, 'open'));

  const [latestRun] = await db
    .select()
    .from(runLogs)
    .orderBy(desc(runLogs.ranAt))
    .limit(1);

  const [latestDd] = await db
    .select()
    .from(drawdownState)
    .orderBy(desc(drawdownState.updatedAt))
    .limit(1);

  return {
    signalsLast24h: Number(signalsLast24h ?? 0),
    acceptedLast24h: Number(acceptedLast24h ?? 0),
    openPositions: Number(openPositions ?? 0),
    latestRunAt: latestRun?.ranAt ?? null,
    equity: latestDd ? Number(latestDd.currentEquity) : null,
    peakEquity: latestDd ? Number(latestDd.peakEquity) : null,
    drawdownPct: latestDd ? Number(latestDd.drawdownPct) : null,
    killSwitchTripped: latestDd?.killSwitchTripped ?? false,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export function startUi(): void {
  const cfg = loadConfig();
  if (!cfg.UI_USER || !cfg.UI_PASS) {
    throw new Error('UI requires UI_USER and UI_PASS env vars (refusing to start wide-open)');
  }
  const port = cfg.UI_PORT;
  const user = cfg.UI_USER;
  const pass = cfg.UI_PASS;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      if (!checkBasicAuth(req, user, pass)) return unauthorized(res);

      if (req.method === 'GET' && path === '/')              return send(res, 200, DASHBOARD_HTML, 'text/html');
      if (req.method === 'GET' && path === '/api/summary')   return send(res, 200, await apiSummary());
      if (req.method === 'GET' && path === '/api/strategies') return send(res, 200, await apiStrategies());
      if (req.method === 'GET' && path === '/api/runs')      return send(res, 200, await apiRuns());
      if (req.method === 'GET' && path === '/api/signals')   return send(res, 200, await apiSignals());
      if (req.method === 'GET' && path === '/api/orders')    return send(res, 200, await apiOrders());
      if (req.method === 'GET' && path === '/api/positions') return send(res, 200, await apiPositions());
      if (req.method === 'GET' && path === '/api/drawdown')  return send(res, 200, await apiDrawdown());

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[ui] error', err);
      return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, () => {
    console.log(`[ui] AlphaStack dashboard at http://localhost:${port}/  (basic auth)`);
  });
}

// Detect direct execution in a cross-platform way. The naive
// `file://${process.argv[1]}` comparison breaks on Windows because
// process.argv[1] uses backslashes while import.meta.url uses forward
// slashes + `file:///` (three slashes) for absolute paths.
const entry = process.argv[1];
const isDirectRun = entry ? import.meta.url === pathToFileURL(entry).href : false;

if (isDirectRun) {
  // Auto-load .env for local dev (Node 20.12+ native, no dep)
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
  startUi();
}
