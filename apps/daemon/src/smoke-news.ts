/**
 * Live smoke test for the news path: real Yahoo feed, real Claude CLI, no venue.
 *
 * Run with `pnpm smoke:news`. Spends a few cents of metered credit and places
 * no orders — it exists to prove the scout works against the live world rather
 * than only against fixtures.
 */
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus } from '@aegis/agents';
import { YahooNewsSource } from '@aegis/marketdata';
import { NewsScoutAgent, universeFor, type NewsDeps } from '@aegis/pipeline';

const db = openDb(':memory:');
const log = createLogger({});
const budget = new BudgetGovernor(db, 100, `${new Date().toISOString().slice(0, 7)}-01`);

const deps: NewsDeps = {
  db,
  bus: new SignalBus(db),
  log,
  budget,
  news: new YahooNewsSource(),
  edgar: {} as never,
  consensus: {} as never,
  prices: {} as never,
  router: {} as never,
  universe: universeFor(['US', 'CRYPTO', 'IN']),
  sueThreshold: 1.5,
  auditFloor: 70,
  autonomy: 'SHADOW',
  batchCap: 12,
};

log.ok('smoke', `news scout over ${String(deps.universe.length)} symbols — live feed, live model`);
await new NewsScoutAgent(deps).execute();
log.budget(budget.spent(), 100, new Date().getDate());
const sigs = deps.bus.read(['news_signal'], 20);
log.ok('smoke', `${String(sigs.length)} actionable signal(s)`);
for (const s of sigs) {
  const d = s.data as { title: string; category: string; direction: number; why: string };
  log.event('smoke', `${s.symbol ?? '?'}  ${d.category}  dir=${d.direction.toFixed(2)}  ${d.title.slice(0, 70)}`);
}
db.close();
