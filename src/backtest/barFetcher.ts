import { request } from 'undici';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import type { CryptoBar, Timeframe } from '../broker/alpacaCrypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, '../../backtest-data');

// Alpaca returns at most 10k bars per page. 1H × 2 years = ~17,520 bars,
// so 1H needs pagination. Daily and 4H fit comfortably under the limit.
const PAGE_LIMIT = 10_000;

interface BarsResponse {
  bars: Record<string, CryptoBar[]>;
  next_page_token?: string | null;
}

/**
 * Fetch all bars for one (symbol, timeframe, [start, end]) range, paging
 * through Alpaca until next_page_token is null. Returns bars sorted by
 * timestamp ascending.
 */
export async function fetchBars(
  symbol: string,
  timeframe: Timeframe,
  start: string,
  end: string,
): Promise<CryptoBar[]> {
  const cfg = loadConfig();
  const all: CryptoBar[] = [];
  let pageToken: string | null = null;
  let page = 0;

  do {
    const url = new URL('/v1beta3/crypto/us/bars', cfg.ALPACA_DATA_BASE_URL);
    url.searchParams.set('symbols', symbol);
    url.searchParams.set('timeframe', timeframe);
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await request(url.toString(), {
      method: 'GET',
      headers: {
        'APCA-API-KEY-ID': cfg.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': cfg.ALPACA_SECRET_KEY,
      },
    });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`Alpaca bars ${symbol} ${timeframe} -> ${res.statusCode}: ${text}`);
    }
    const data = JSON.parse(text) as BarsResponse;
    const batch = data.bars?.[symbol] ?? [];
    all.push(...batch);
    pageToken = data.next_page_token ?? null;
    page++;
    if (page > 50) throw new Error(`Pagination exceeded 50 pages for ${symbol} ${timeframe}`);
  } while (pageToken);

  // Defensive sort — Alpaca returns sorted but make sure
  all.sort((a, b) => a.t.localeCompare(b.t));
  return all;
}

// ---------------------------------------------------------------------------
// Disk cache — backtest-data/<symbol>_<timeframe>_<start>_<end>.json
// ---------------------------------------------------------------------------

function cacheKey(symbol: string, timeframe: Timeframe, start: string, end: string): string {
  // sanitize symbol slash for filename safety
  const safe = symbol.replace('/', '-');
  return `${safe}_${timeframe}_${start.slice(0, 10)}_${end.slice(0, 10)}.json`;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function getBarsCached(
  symbol: string,
  timeframe: Timeframe,
  start: string,
  end: string,
): Promise<CryptoBar[]> {
  await mkdir(CACHE_DIR, { recursive: true });
  const path = resolve(CACHE_DIR, cacheKey(symbol, timeframe, start, end));
  if (await exists(path)) {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as CryptoBar[];
  }
  console.log(`[barFetcher] fetching ${symbol} ${timeframe} ${start.slice(0, 10)}..${end.slice(0, 10)}`);
  const bars = await fetchBars(symbol, timeframe, start, end);
  await writeFile(path, JSON.stringify(bars));
  console.log(`[barFetcher] cached ${bars.length} bars -> ${path}`);
  return bars;
}

/**
 * Prefetch every (symbol × timeframe) combination needed for a backtest
 * run. Use this before the replay loop to warm the disk cache and surface
 * any API errors early.
 */
export async function prefetchUniverse(
  symbols: string[],
  timeframes: Timeframe[],
  start: string,
  end: string,
): Promise<void> {
  for (const symbol of symbols) {
    for (const tf of timeframes) {
      await getBarsCached(symbol, tf, start, end);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI: `npx tsx src/backtest/barFetcher.ts BTC/USD 1Day 2024-01-01 2026-01-01`
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , symbol, timeframe, start, end] = process.argv;
  if (!symbol || !timeframe || !start || !end) {
    console.error('usage: barFetcher.ts <symbol> <1Hour|4Hour|1Day> <start> <end>');
    process.exit(2);
  }
  getBarsCached(symbol, timeframe as Timeframe, start, end)
    .then((bars) => {
      console.log(`fetched ${bars.length} bars; first=${bars[0]?.t} last=${bars[bars.length - 1]?.t}`);
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
