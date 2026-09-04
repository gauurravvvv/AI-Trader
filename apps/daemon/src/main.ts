import { loadConfig } from '@aegis/config';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus, Orchestrator, startHeartbeat, type AgentDeps } from '@aegis/agents';
import { setConcurrency } from '@aegis/claude';
import {
  SimAdapter, US_COSTS, CRYPTO_COSTS, IN_COSTS,
  US_CALENDAR, CRYPTO_CALENDAR, IN_CALENDAR,
  holidaysCoverYear,
  type FillEvent,
} from '@aegis/brokers';
import { YahooPriceSource, YahooConsensus, YahooNewsSource } from '@aegis/marketdata';
import { Ledger, Reconciler } from '@aegis/ledger';
import { OrderRouter, isHalted } from '@aegis/risk';
import { EdgarClient } from '@aegis/edgar';
import { Dashboard } from '@aegis/dashboard';
import { Notifier, ConsoleTransport, fillBody, type NotifyHook } from '@aegis/notify';
import {
  EdgarPollerAgent,
  EarningsReaderAgent,
  PositionGuardianAgent,
  NewsScoutAgent,
  NewsTraderAgent,
  ReflectorAgent,
  EntryLadderAgent,
  DailySummary,
  universeFor,
  type PipelineDeps,
  type NewsDeps,
  type NewsTraderDeps,
  type Venue,
} from '@aegis/pipeline';

const cfg = loadConfig(process.env);

const argAt = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const agentFilter = argAt('--agent');
const autonomy = (argAt('--autonomy') ?? process.env.AUTONOMY ?? 'SHADOW') as 'SHADOW' | 'AUTO';

const log = createLogger({
  level: cfg.logLevel,
  verbose: cfg.verbose || process.argv.includes('--verbose'),
  ...(agentFilter !== undefined ? { agentFilter } : {}),
});

const db = openDb(cfg.dbPath);
const bus = new SignalBus(db);
const cycleStart = `${new Date().toISOString().slice(0, 7)}-01`;

// The Budget Governor needs to raise notifications, but the Notifier needs a
// database and a logger that exist by the time it is built. Rather than reorder
// construction around one edge, notifications raised before the outbox exists
// are dropped into a no-op and the hook is swapped in below.
let raise: NotifyHook = () => undefined;
const budget = new BudgetGovernor(db, cfg.monthlyBudgetUsd, cycleStart, (n) => {
  raise(n);
});
setConcurrency(cfg.claudeConcurrency);

// ── Market data and venue. Both keyless: no signup, no API key. ──
const prices = new YahooPriceSource();
const consensus = new YahooConsensus();
const news = new YahooNewsSource();
const startingCash = process.env.STARTING_CASH ?? '100000';

const adapter = new SimAdapter(
  'sim-us',
  'US',
  prices,
  US_COSTS,
  startingCash,
  { tickSize: '0.01', lotSize: '1', minNotional: '1', supportsFractional: false, supportsShort: false },
  US_CALENDAR,
);

// Crypto trades around the clock, in fractions, on a different cost stack.
// Note what the 24/7 calendar removes: the market-hours gate is the guard that
// stops the US pipeline overnight, so on this venue the position caps, the
// daily loss stop and the kill switch are the only things between a bad signal
// at 03:00 and a filled order.
const cryptoAdapter = new SimAdapter(
  'sim-crypto',
  'CRYPTO',
  prices,
  CRYPTO_COSTS,
  process.env.STARTING_CASH_CRYPTO ?? '25000',
  { tickSize: '0.01', lotSize: '0.0001', minNotional: '10', supportsFractional: true, supportsShort: false },
  CRYPTO_CALENDAR,
);

// India. The full statutory cost stack is material and is modelled rather than
// waved away: brokerage, STT, exchange charges, GST and stamp duty, plus a flat
// per-order fee. No Indian broker offers a real paper sandbox, and SEBI's algo
// framework has required static-IP whitelisting, a registered strategy ID and
// exchange empanelment since 2026-04-01 — simulating keeps that surface at zero.
const indiaAdapter = new SimAdapter(
  'sim-india',
  'IN',
  prices,
  IN_COSTS,
  process.env.STARTING_CASH_INDIA ?? '500000',
  { tickSize: '0.05', lotSize: '1', minNotional: '500', supportsFractional: false, supportsShort: false },
  IN_CALENDAR,
);

const ledger = new Ledger(db);

// Console transport by default: the system must be fully runnable with no email
// provider configured, and a missing SMTP account must not silently disable the
// record of what was decided. Set NOTIFY_TO with a real transport to send.
const notifier = new Notifier({
  db,
  log,
  transport: new ConsoleTransport(log),
  to: process.env.NOTIFY_TO ?? 'operator@localhost',
});
const stopNotifier = notifier.start(15_000);
raise = (n) => {
  notifier.enqueue(n);
};

const onFill = (venue: string) => (f: FillEvent) => {
  log.ok('execution', `FILLED ${f.side} ${f.qty} ${f.symbol} @ ${Number(f.price).toFixed(2)} (${venue})`);
  notifier.enqueue({
    kind: 'ORDER_FILLED',
    subject: `${f.side.toUpperCase()} ${f.qty} ${f.symbol} @ ${Number(f.price).toFixed(2)}`,
    body: fillBody({
      symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fee: f.fee,
    }),
  });
};

const router = new OrderRouter({ db, adapter, ledger, notify: raise, onFill: onFill(adapter.venue) });
router.start();

const cryptoRouter = new OrderRouter({
  db,
  adapter: cryptoAdapter,
  ledger,
  notify: raise,
  onFill: onFill(cryptoAdapter.venue),
});
cryptoRouter.start();

const indiaRouter = new OrderRouter({
  db,
  adapter: indiaAdapter,
  ledger,
  notify: raise,
  onFill: onFill(indiaAdapter.venue),
});
indiaRouter.start();

const venues: Venue[] = [
  { market: 'US', router, ledger },
  { market: 'CRYPTO', router: cryptoRouter, ledger },
  { market: 'IN', router: indiaRouter, ledger },
];

const reconciler = new Reconciler(ledger, adapter, db);
reconciler.onBreak((r) => {
  log.error('reconciler', `BREAK on ${adapter.venue}: ${JSON.stringify(r.breaks)}`);
  notifier.enqueue({
    kind: 'RECONCILIATION_BREAK',
    subject: `Reconciliation break on ${adapter.venue}`,
    body: `The ledger and the venue disagree.\n\n${JSON.stringify(r.breaks, null, 2)}`,
  });
});
const stopReconciler = reconciler.start(60_000);

const edgar = new EdgarClient({
  userAgent: process.env.SEC_USER_AGENT ?? 'Aegis Research aegis@example.com',
});

const base: AgentDeps = { db, bus, log, budget };
const pipelineDeps: PipelineDeps = {
  ...base,
  edgar,
  consensus,
  prices,
  router,
  universe: universeFor(['US']),
  sueThreshold: cfg.sueThreshold,
  auditFloor: cfg.auditFloor,
  maxFilingAgeDays: cfg.maxFilingAgeDays,
  autonomy,
  notify: raise,
};

// News is the only alpha source that reaches all three markets: crypto has no
// regulator to file with and Indian results go to the exchanges, not the SEC.
// The scout therefore watches the full universe even though only the US names
// have a trading venue wired so far.
const newsUniverse = universeFor(['US', 'CRYPTO', 'IN']);
const newsDeps: NewsDeps = {
  ...pipelineDeps,
  news,
  universe: newsUniverse,
  intervalMinutes: cfg.newsIntervalMin,
};

// The trader sees every scouted signal but can only act on markets with a venue
// wired. India is scouted and not traded; that is deliberate, not an oversight.
const traderDeps: NewsTraderDeps = { ...pipelineDeps, venues, universe: newsUniverse };

// One summary per calendar day, idempotent on the day rather than on a timer,
// so a restart cannot produce a second one.
const daily = new DailySummary(db, budget, adapter.venue, raise);

const orchestrator = new Orchestrator(log);
orchestrator.register(new EdgarPollerAgent(pipelineDeps), 0);
orchestrator.register(new EarningsReaderAgent(pipelineDeps), 10_000);
// Runs regardless of budget tier: the Governor may stop us opening a position,
// it must never stop us closing one.
orchestrator.register(new PositionGuardianAgent({ ...pipelineDeps, ledger }), 20_000);
orchestrator.register(new NewsScoutAgent(newsDeps), 30_000);
orchestrator.register(new NewsTraderAgent(traderDeps), 40_000);
// A guardian per venue: exits are per-book, and crypto's book never closes.
orchestrator.register(
  new PositionGuardianAgent({ ...pipelineDeps, ledger, router: cryptoRouter }),
  50_000,
);
// Reads closed trades and records what to do differently. Alpha-aware: a +8%
// trade in a +12% market is not a win, and scoring it as one would teach the
// system to repeat whatever it did in a bull market.
orchestrator.register(
  new PositionGuardianAgent({ ...pipelineDeps, ledger, router: indiaRouter }),
  55_000,
);
// Reads closed trades and records what to do differently. Alpha-aware: a +8%
// trade in a +12% market is not a win, and scoring it as one would teach the
// system to repeat whatever it did in a bull market.
orchestrator.register(new ReflectorAgent({ ...pipelineDeps, prices }), 60_000);
// One ladder per venue. Entries are staged rather than sent whole, so the
// market gets a chance to disagree between rungs.
for (const [i, r] of [router, cryptoRouter, indiaRouter].entries()) {
  orchestrator.register(new EntryLadderAgent({ ...pipelineDeps, prices, router: r }), 65_000 + i * 5_000);
}

const dashboard = new Dashboard({
  db,
  port: cfg.dashboardPort,
  monthlyBudgetUsd: cfg.monthlyBudgetUsd,
  autonomy,
  venue: adapter.venue,
  onHaltChange: (h) => {
    log.warn('dashboard', h ? 'KILL SWITCH ENGAGED from the dashboard' : 'halt cleared');
    notifier.enqueue({
      kind: 'KILL_SWITCH',
      subject: h ? 'Aegis HALTED' : 'Aegis halt cleared',
      body: h ? 'The kill switch was engaged from the dashboard.' : 'Trading may resume.',
    });
  },
});
dashboard.start();

const HEARTBEAT_MS = 5 * 60 * 1000;
// The dashboard polls its own snapshot; this pushes so an idle browser still
// reflects a fill that happened while nobody was looking.
const DASH_PUSH_MS = 3000;

log.ok('daemon', `aegis up · mode=${cfg.tradingMode} · autonomy=${autonomy} · db=${cfg.dbPath}`);
log.event(
  'daemon',
  `venue=${adapter.venue} (simulated) · budget tier ${budget.tier()} · concurrency ${String(cfg.claudeConcurrency)}`,
);
log.event(
  'daemon',
  `earnings universe ${String(pipelineDeps.universe.length)} US names · SUE gate ${String(cfg.sueThreshold)} · audit floor ${String(cfg.auditFloor)}`,
);
log.event(
  'daemon',
  `news universe ${String(newsUniverse.length)} names across US, crypto and India`,
);
log.event(
  'daemon',
  `venues: ${venues.map((v) => `${v.router.venue} (${v.market})`).join(', ')}`,
);
if (!holidaysCoverYear(new Date(), 'America/New_York')) {
  log.warn(
    'daemon',
    'the exchange holiday lists do not cover this year — sessions on unlisted holidays will look open',
  );
}
if (isHalted(db)) log.warn('daemon', 'system is HALTED — clear it to resume trading');
if (autonomy === 'SHADOW') {
  log.warn('daemon', 'SHADOW mode: decisions are logged, no orders placed. Use --autonomy AUTO to trade.');
}

orchestrator.start();
log.ok('dashboard', `http://localhost:${String(cfg.dashboardPort)}`);

const dashTimer = setInterval(() => {
  dashboard.broadcast('tick', dashboard.snapshot());
}, DASH_PUSH_MS);

const reportBudget = (): void => {
  log.budget(budget.spent(), cfg.monthlyBudgetUsd, new Date().getDate());
  if (daily.maybeSend()) log.event('notifier', 'daily summary queued');
};
reportBudget();

// Holds the event loop open. A signal handler alone does not.
const stopHeartbeat = startHeartbeat(HEARTBEAT_MS, reportBudget);

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.warn('daemon', `${sig} received — stopping agents`);
    stopHeartbeat();
    stopNotifier();
    void notifier.drain();
    clearInterval(dashTimer);
    dashboard.stop();
    stopReconciler();
    router.stop();
    cryptoRouter.stop();
    indiaRouter.stop();
    orchestrator.stop();
    db.close();
    log.ok('daemon', 'clean shutdown');
    process.exit(0);
  });
}
