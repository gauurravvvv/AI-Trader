import { loadConfig } from '@aegis/config';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus, Orchestrator, startHeartbeat, type AgentDeps } from '@aegis/agents';
import { setConcurrency } from '@aegis/claude';

const cfg = loadConfig(process.env);

const filterIdx = process.argv.indexOf('--agent');
const agentFilter = filterIdx >= 0 ? process.argv[filterIdx + 1] : undefined;

const log = createLogger({
  verbose: cfg.verbose || process.argv.includes('--verbose'),
  ...(agentFilter !== undefined ? { agentFilter } : {}),
});

const db = openDb(cfg.dbPath);
const bus = new SignalBus(db);
// Credit cycles are monthly; the first of the current month is the cycle key.
const cycleStart = `${new Date().toISOString().slice(0, 7)}-01`;
const budget = new BudgetGovernor(db, cfg.monthlyBudgetUsd, cycleStart);
setConcurrency(cfg.claudeConcurrency);

// Agents are registered here from Phase 3 onward.
const deps: AgentDeps = { db, bus, log, budget };
void deps;

const orchestrator = new Orchestrator(log);
const HEARTBEAT_MS = 5 * 60 * 1000;

// The daemon is intentionally runnable with zero agents. A skeleton that boots,
// reports and shuts down cleanly is the thing to prove before anything trades.

log.ok('daemon', `aegis up · mode=${cfg.tradingMode} · db=${cfg.dbPath}`);
log.event(
  'daemon',
  `budget tier ${budget.tier()} · claude concurrency ${String(cfg.claudeConcurrency)}`,
);
orchestrator.start();

const reportBudget = (): void => {
  log.budget(budget.spent(), cfg.monthlyBudgetUsd, new Date().getDate());
};
reportBudget();

// Holds the event loop open. A signal handler alone does not — with zero
// agents registered the process would drain and exit silently, which is
// indistinguishable from a crash.
const stopHeartbeat = startHeartbeat(HEARTBEAT_MS, reportBudget);

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1); // a second Ctrl-C forces
    shuttingDown = true;
    log.warn('daemon', `${sig} received — stopping agents`);
    stopHeartbeat();
    orchestrator.stop();
    db.close();
    log.ok('daemon', 'clean shutdown');
    process.exit(0);
  });
}
