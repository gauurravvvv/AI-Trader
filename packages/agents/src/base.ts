import type { Db } from '@aegis/db';
import type { Logger } from '@aegis/logger';
import type { BudgetGovernor } from '@aegis/budget';
import type { SignalBus } from './bus.js';

export interface AgentDeps {
  db: Db;
  bus: SignalBus;
  log: Logger;
  budget: BudgetGovernor;
  /** Injectable clock — the sleep-gap test cannot wait an hour. */
  now?: () => number;
}

export interface AgentStats {
  name: string;
  enabled: boolean;
  running: boolean;
  runs: number;
  skipped: number;
  errors: number;
  lastRun: number;
}

export abstract class BaseAgent {
  protected readonly db: Db;
  protected readonly bus: SignalBus;
  protected readonly log: Logger;
  protected readonly budget: BudgetGovernor;
  private readonly now: () => number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private enabled = true;
  private lastTickAt = 0;
  private readonly s = { runs: 0, skipped: 0, errors: 0, lastRun: 0 };

  constructor(
    readonly name: string,
    protected readonly opts: { intervalMs: number },
    deps: AgentDeps,
  ) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.log = deps.log;
    this.budget = deps.budget;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** Override to gate execution — market hours, open positions, budget tier. */
  shouldRun(): boolean {
    return true;
  }

  abstract execute(): Promise<void>;

  async tick(): Promise<void> {
    if (this.running || !this.enabled) return; // never overlap with itself
    this.running = true;
    try {
      const now = this.now();
      // A laptop lid closing mid-session is a real failure mode: timers do not
      // fire while suspended, and the first tick after wake carries stale
      // state. Detect the gap explicitly rather than acting on stale data.
      if (this.lastTickAt > 0 && now - this.lastTickAt > this.opts.intervalMs * 2.5) {
        const mins = Math.round((now - this.lastTickAt) / 60_000);
        this.log.warn(this.name, `resumed after a ${String(mins)}m gap (system sleep?)`);
        this.writeLog('wake_recovery', null, `gap ${String(mins)}m`);
        await this.onWake();
      }
      this.lastTickAt = now;

      if (!this.shouldRun()) {
        this.s.skipped++;
        return;
      }

      await this.execute();
      this.s.runs++;
      this.s.lastRun = now;
    } catch (err) {
      this.s.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(this.name, msg);
      this.writeLog('error', null, msg);
    } finally {
      this.running = false;
    }
  }

  /** Override to drop caches after a suspend. */
  protected async onWake(): Promise<void> {
    /* default: nothing */
  }

  start(): void {
    this.log.ok(this.name, `started · every ${String(Math.round(this.opts.intervalMs / 1000))}s`);
    this.writeLog('started', null, `interval=${String(this.opts.intervalMs)}ms`);
    this.lastTickAt = this.now();
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.log.event(this.name, 'stopped');
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  stats(): AgentStats {
    return { name: this.name, enabled: this.enabled, running: this.running, ...this.s };
  }

  protected writeLog(action: string, symbol: string | null, details: string | null): void {
    try {
      this.db
        .prepare('INSERT INTO agent_logs (agent, action, symbol, details) VALUES (?,?,?,?)')
        .run(this.name, action, symbol, details);
    } catch {
      /* logging must never crash an agent */
    }
  }
}
