/**
 * Print the performance report. `pnpm report`.
 *
 * Reads the ledger and asks the only question that matters: did any of this beat
 * doing nothing? Costs nothing in model credit — it is arithmetic over rows that
 * already exist.
 */
import { loadConfig } from '@aegis/config';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { YahooPriceSource } from '@aegis/marketdata';
import {
  closedTrades, summarise, compareToBenchmark, byConfidence, bySource, performanceReport,
  randomEntryControl, controlReport, groupLessons, universeFor,
} from '@aegis/pipeline';

const cfg = loadConfig(process.env);
const log = createLogger({});
const db = openDb(cfg.dbPath);

const venueArg = process.argv.indexOf('--venue');
const venue = venueArg >= 0 ? process.argv[venueArg + 1] : undefined;

const trades = closedTrades(db, venue);
const fees = db
  .prepare(
    `SELECT COALESCE(SUM(CAST(f.fee AS REAL)), 0) v
       FROM fills f JOIN orders o ON o.id = f.order_id
      ${venue === undefined ? '' : 'WHERE o.venue = ?'}`,
  )
  .get(...(venue === undefined ? [] : [venue])) as { v: number };

const perf = summarise(trades, fees.v.toFixed(4));

// Benchmark over the window the book was actually active, not a fixed period —
// comparing a two-week strategy against a one-year index return says nothing.
const prices = new YahooPriceSource();
const days = trades.length === 0
  ? 30
  : Math.max(
      5,
      Math.ceil((Date.now() - Date.parse(trades[0]!.openedAt)) / 86_400_000),
    );
const bars = await prices.bars('SPY', days);
const first = bars.at(0)?.c ?? 0;
const latest = bars.at(-1)?.c ?? 0;

const bench = compareToBenchmark(
  perf.realised,
  process.env.STARTING_CASH ?? '100000',
  first,
  latest,
  trades.length,
);

log.raw('');
log.raw(performanceReport(perf, bench, byConfidence(trades), bySource(trades)));
// The control the index comparison cannot provide: beating SPY says the book
// made money, beating a random pick from the same universe held for the same
// days says the selection did something.
const universe = universeFor(['US', 'CRYPTO']).map((e) => e.symbol);
const control = await randomEntryControl(
  trades.map((t) => ({
    symbol: t.symbol,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    actualReturn: Number(t.pnl) / Math.max(1, Number(process.env.STARTING_CASH ?? '100000') * 0.03),
  })),
  universe,
  async (symbol, openedAt, closedAt) => {
    const span = Math.max(2, Math.ceil((Date.parse(closedAt) - Date.parse(openedAt)) / 86_400_000) + 3);
    const b = await prices.bars(symbol, span);
    if (b.length < 2) return null;
    const a0 = b.at(0)?.c ?? 0;
    const a1 = b.at(-1)?.c ?? 0;
    return a0 > 0 ? (a1 - a0) / a0 : null;
  },
);
log.raw('');
log.raw(controlReport(control));

const lessons = groupLessons(db);
if (lessons.length > 0) {
  log.raw('');
  log.raw('WHAT THE REFLECTOR LEARNED  (worst mean alpha first)');
  for (const g of lessons) {
    log.raw(`  ${g.category.padEnd(32)} ${String(g.count).padStart(3)}x  ${(g.meanAlpha * 100).toFixed(2)}%`);
    for (const e of g.examples) log.raw(`      ${e.slice(0, 96)}`);
  }
}

log.raw('');
log.raw(`  Window: ${String(days)} days · benchmark ${first.toFixed(2)} → ${latest.toFixed(2)}`);
log.raw(`  Venue:  ${venue ?? 'all'} · database ${cfg.dbPath}`);
log.raw('');
log.raw('  PAPER TRADING ONLY. No real money is at risk.');
log.raw('');
db.close();
