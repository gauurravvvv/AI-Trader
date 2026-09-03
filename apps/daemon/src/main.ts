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
import {
  EdgarPollerAgent,
  EarningsReaderAgent,
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
  verbose: cfg.verbose || process.argv.includes('--verbose'),
  ...(agentFilter !== undefined ? { agentFilter } : {}),
});

const db = openDb(cfg.dbPath);
const bus = new SignalBus(db);
const cycleStart = `${new Date().toISOString().slice(0, 7)}-01`;
const budget = new BudgetGovernor(db, cfg.monthlyBudgetUsd, cycleStart);
setConcurrency(cfg.claudeConcurrency);

// ── Market data and venue. Both keyless: no signup, no API key. ──
const prices = new YahooPriceSource();
const consensus = new YahooConsensus();
const adapter = new SimAdapter(
  'alpaca-paper',
  'US',
  prices,
  US_COSTS,
  process.env.STARTING_CASH ?? '100000',
  { tickSize: '0.01', lotSize: '1', minNotional: '1', supportsFractional: false, supportsShort: false },
  { isOpen: isUsMarketOpen },
);

const ledger = new Ledger(db);
const router = new OrderRouter({
  db,
  adapter,
  ledger,
  onFill: (f) => {
    log.ok('execution', `FILLED ${f.side} ${f.qty} ${f.symbol} @ ${Number(f.price).toFixed(2)}`);
  },
});
router.start();

const reconciler = new Reconciler(ledger, adapter, db);
reconciler.onBreak((r) => {
  log.error('reconciler', `BREAK on ${adapter.venue}: ${JSON.stringify(r.breaks)}`);
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
};

const orchestrator = new Orchestrator(log);
orchestrator.register(new EdgarPollerAgent(pipelineDeps), 0);
orchestrator.register(new EarningsReaderAgent(pipelineDeps), 10_000);

const HEARTBEAT_MS = 5 * 60 * 1000;

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

const reportBudget = (): void => {
  log.budget(budget.spent(), cfg.monthlyBudgetUsd, new Date().getDate());
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
