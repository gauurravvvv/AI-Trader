import { loadConfig } from '@aegis/config';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus, Orchestrator, startHeartbeat, type AgentDeps } from '@aegis/agents';
import { setConcurrency } from '@aegis/claude';
import { SimAdapter, US_COSTS } from '@aegis/brokers';
import { YahooPriceSource, YahooConsensus } from '@aegis/marketdata';
import { Ledger, Reconciler } from '@aegis/ledger';
import { OrderRouter, isHalted } from '@aegis/risk';
import { EdgarClient } from '@aegis/edgar';
import { Dashboard } from '@aegis/dashboard';
import { Notifier, ConsoleTransport, fillBody, type NotifyHook } from '@aegis/notify';
import {
  EdgarPollerAgent,
  EarningsReaderAgent,
  PositionGuardianAgent,
  DailySummary,
  universeFor,
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

// ── Market data and venue. Both keyless: no signup, no API key. ──
const prices = new YahooPriceSource();
const consensus = new YahooConsensus();
const adapter = new SimAdapter(
  'sim-us',
  'US',
  prices,
  US_COSTS,
  process.env.STARTING_CASH ?? '100000',
  { tickSize: '0.01', lotSize: '1', minNotional: '1', supportsFractional: false, supportsShort: false },
  { isOpen: isUsMarketOpen },
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

const router = new OrderRouter({
  db,
  adapter,
  ledger,
  notify: raise,
  onFill: (f) => {
    log.ok('execution', `FILLED ${f.side} ${f.qty} ${f.symbol} @ ${Number(f.price).toFixed(2)}`);
    notifier.enqueue({
      kind: 'ORDER_FILLED',
      subject: `${f.side.toUpperCase()} ${f.qty} ${f.symbol} @ ${Number(f.price).toFixed(2)}`,
      body: fillBody({
        symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fee: f.fee,
      }),
    });
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
  autonomy,
  notify: raise,
};

// One summary per calendar day, idempotent on the day rather than on a timer,
// so a restart cannot produce a second one.
const daily = new DailySummary(db, budget, adapter.venue, raise);

const orchestrator = new Orchestrator(log);
orchestrator.register(new EdgarPollerAgent(pipelineDeps), 0);
orchestrator.register(new EarningsReaderAgent(pipelineDeps), 10_000);
// Runs regardless of budget tier: the Governor may stop us opening a position,
// it must never stop us closing one.
orchestrator.register(new PositionGuardianAgent({ ...pipelineDeps, ledger }), 20_000);

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
  `universe ${String(pipelineDeps.universe.length)} US names · SUE gate ${String(cfg.sueThreshold)} · audit floor ${String(cfg.auditFloor)}`,
);
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
    orchestrator.stop();
    db.close();
    log.ok('daemon', 'clean shutdown');
    process.exit(0);
  });
}

/** US equities regular session, 09:30–16:00 ET, weekdays. */
function isUsMarketOpen(at: Date): boolean {
  const et = new Date(at.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}
