import type { Logger } from '@aegis/logger';
import type { BaseAgent, AgentStats } from './base.js';

export class Orchestrator {
  private readonly entries: { agent: BaseAgent; delayMs: number }[] = [];
  private timers: NodeJS.Timeout[] = [];
  private started = false;

  constructor(private readonly log: Logger) {}

  register(agent: BaseAgent, delayMs = 0): void {
    this.entries.push({ agent, delayMs });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.log.ok('orchestrator', `starting ${String(this.entries.length)} agents`);
    for (const { agent, delayMs } of this.entries) {
      // Staggered so a cold start does not fire every agent — and every data
      // fetch — in the same millisecond.
      if (delayMs === 0) agent.start();
      else
        this.timers.push(
          setTimeout(() => {
            agent.start();
          }, delayMs),
        );
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const { agent } of this.entries) agent.stop();
    this.log.event('orchestrator', 'all agents stopped');
  }

  status(): AgentStats[] {
    return this.entries.map((e) => e.agent.stats());
  }
}
