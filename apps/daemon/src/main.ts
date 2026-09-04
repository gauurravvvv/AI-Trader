import { loadConfig } from '@aegis/config';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus, Orchestrator, startHeartbeat, type AgentDeps } from '@aegis/agents';
import { setConcurrency } from '@aegis/claude';
import { SimAdapter, US_COSTS, US_CALENDAR, holidaysCoverYear, type FillEvent } from '@aegis/brokers';
import { YahooPriceSource, YahooNewsSource } from '@aegis/marketdata';
import { Ledger, Reconciler } from '@aegis/ledger';
import { OrderRouter, isHalted, DEFAULT_LIMITS } from '@aegis/risk';
import { Dashboard } from '@aegis/dashboard';
import {
  Notifier, ConsoleTransport, SmtpTransport, smtpFromEnv, fillBody, type NotifyHook, type Transport,
} from '@aegis/notify';
import {
  MarketRegimeAgent,
  NewsScoutAgent,
  SentinelAgent,
  PositionGuardianAgent,
  EntryLadderAgent,
  ReflectorAgent,
  DailySummary,
  US_UNIVERSE,
  type PipelineDeps,
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

// ── Market data and venue. Keyless: no signup, no API key. ──
const prices = new YahooPriceSource();
const news = new YahooNewsSource();

// US equities only. Short selling is enabled: over half of all news is bearish,
// and a system that can only express one direction throws that away.
const adapter = new SimAdapter(
  'sim-us',
  'US',
  prices,
  US_COSTS,
  process.env.STARTING_CASH ?? '100000',
  { tickSize: '0.01', lotSize: '1', minNotional: '1', supportsFractional: false, supportsShort: true },
  US_CALENDAR,
);

const ledger = new Ledger(db);

// Real email when SMTP is configured, the terminal otherwise. A half-set
// configuration throws inside smtpFromEnv rather than silently not sending.
const smtp = smtpFromEnv(process.env);
const transport: Transport = smtp ? new SmtpTransport(smtp, log) : new ConsoleTransport(log);
const notifier = new Notifier({
  db,
  log,
  transport,
  to: process.env.NOTIFY_TO ?? smtp?.from ?? 'operator@localhost',
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
    body: fillBody({ symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fee: f.fee }),
  });
};

const router = new OrderRouter({
  db,
  adapter,
  ledger,
  notify: raise,
  onFill: onFill(adapter.venue),
  limits: {
    ...DEFAULT_LIMITS,
    maxOpenPositions: cfg.maxOpenPositions,
    maxTradesPerDay: cfg.maxTradesPerDay,
  },
});
router.start();

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

const base: AgentDeps = { db, bus, log, budget };
const universe = US_UNIVERSE;
const pipelineDeps: PipelineDeps = {
  ...base,
  // The earnings path is retired: it only fires four times a year per name and
  // the user asked not to depend on it. These are unused by the agents below
  // and kept only because PipelineDeps is shared.
  edgar: {} as never,
  consensus: {} as never,
  prices,
  router,
  universe,
  sueThreshold: cfg.sueThreshold,
  auditFloor: cfg.auditFloor,
  autonomy,
  notify: raise,
};

const daily = new DailySummary(db, budget, adapter.venue, raise);

// ── The loop, in the order it runs ──
//
//   market-regime   what is the market doing?        no model
//   news-scout      what happened to these names?    haiku, one batched call
//   sentinel        screen -> analyst -> challenger  two sonnet calls
//   ladder          walk the staged entry            no model
//   guardian        stop, target, trail, thesis      no model
//   reflector       what should change next time     haiku
//
// Three of six spend money, and only the sentinel can spend without bound —
// which is why it carries a hard daily cap of its own.
const orchestrator = new Orchestrator(log);
orchestrator.register(new MarketRegimeAgent({ ...pipelineDeps, prices }), 0);
orchestrator.register(
  new NewsScoutAgent({ ...pipelineDeps, news, intervalMinutes: cfg.newsIntervalMin }),
  15_000,
);
orchestrator.register(
  new SentinelAgent({
    ...pipelineDeps,
    ledger,
    maxAnalysesPerDay: cfg.maxAnalysesPerDay,
    baseSizePct: cfg.baseSizePct,
    analystModel: cfg.analystModel,
    challengerModel: cfg.challengerModel,
  }),
  30_000,
);
orchestrator.register(new EntryLadderAgent({ ...pipelineDeps, prices, router }), 45_000);
// Runs regardless of budget tier: the Governor may stop us opening a position,
// it must never stop us closing one.
orchestrator.register(new PositionGuardianAgent({ ...pipelineDeps, ledger }), 60_000);
orchestrator.register(new ReflectorAgent({ ...pipelineDeps, prices }), 90_000);

const dashboard = new Dashboard({
  db,
  port: cfg.dashboardPort,
  monthlyBudgetUsd: cfg.monthlyBudgetUsd,
  autonomy,
  venue: adapter.venue,
  venues: [adapter.venue],
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
  `venue ${adapter.venue} (simulated, long and short) · budget tier ${budget.tier()} · concurrency ${String(cfg.claudeConcurrency)}`,
);
log.event(
  'daemon',
  `universe ${String(universe.length)} US names · news sweep every ${String(cfg.newsIntervalMin)}m`,
);
log.event(
  'daemon',
  `limits: ${String(cfg.maxOpenPositions)} open · ${String(cfg.maxTradesPerDay)} entries/day · ` +
    `${String(cfg.maxAnalysesPerDay)} analyses/day · ${(cfg.baseSizePct * 100).toFixed(1)}% base size`,
);
log.event(
  'daemon',
  `debate: ${cfg.analystModel} proposes, ${cfg.challengerModel} challenges`,
);
log.event('daemon', `notifications via ${transport.name}${smtp ? ` → ${smtp.host}` : ''}`);
if (!holidaysCoverYear(new Date(), 'America/New_York')) {
  log.warn('daemon', 'the exchange holiday list does not cover this year — unlisted holidays will look open');
}
if (isHalted(db)) log.warn('daemon', 'system is HALTED — clear it to resume trading');
if (autonomy === 'SHADOW') {
  log.warn('daemon', 'SHADOW mode: decisions are logged, no orders placed. Use --autonomy AUTO to trade.');
}

orchestrator.start();
log.ok('dashboard', `http://localhost:${String(cfg.dashboardPort)}`);

if (smtp) {
  // Reported, not enforced: a mail server that is briefly unreachable should
  // not stop the daemon, and the outbox retries.
  void new SmtpTransport(smtp, log).verify().then((ok) => {
    if (ok) log.ok('notifier', `SMTP verified — mail will go to ${notifier.to}`);
  });
}
notifier.enqueue({
  kind: 'DAILY_SUMMARY',
  subject: `Aegis started — ${autonomy} on ${adapter.venue}`,
  body: [
    `Aegis is up in ${autonomy} mode against ${adapter.venue}.`,
    '',
    `Universe:   ${String(universe.length)} US names`,
    `Limits:     ${String(cfg.maxOpenPositions)} open positions, ${String(cfg.maxTradesPerDay)} entries/day`,
    `Budget:     $${String(cfg.monthlyBudgetUsd)} this cycle, tier ${budget.tier()}`,
    `Dashboard:  http://localhost:${String(cfg.dashboardPort)}`,
    '',
    autonomy === 'AUTO'
      ? 'Simulated orders WILL be placed. Paper money only.'
      : 'SHADOW mode: decisions are recorded, no orders are placed.',
  ].join('\n'),
});

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
    orchestrator.stop();
    db.close();
    log.ok('daemon', 'clean shutdown');
    process.exit(0);
  });
}
