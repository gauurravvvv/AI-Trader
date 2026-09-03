/**
 * End-to-end proof of the Phase 0-2 spine: a real agent makes a real `claude -p`
 * call, the cost is recorded against the budget, the response is parsed through
 * the tolerant parser, a signal crosses the bus, and a second agent consumes it.
 * Throwaway — delete once the real Earnings Reader lands in Phase 4.
 */
import { z } from 'zod';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus, BaseAgent, type AgentDeps } from '@aegis/agents';
import { askClaude, parseModelJson } from '@aegis/claude';

const Schema = z.object({
  surpriseDirection: z.enum(['BEAT', 'MISS', 'INLINE', 'UNCLEAR']),
  guidanceDelta: z.enum(['RAISED', 'MAINTAINED', 'LOWERED', 'WITHDRAWN', 'NONE']),
  confidence: z.number().min(0).max(100),
  oneLineWhy: z.string(),
});

const FILING =
  'ACME Corp Q3: revenue $4.2B vs $3.9B expected, up 31% YoY. EPS $1.84 vs $1.61 ' +
  'expected. Management raised full-year guidance to $17.5B from $16.8B, citing ' +
  'accelerating enterprise demand. Gross margin expanded 240bps to 68.1%.';

class DemoReader extends BaseAgent {
  constructor(d: AgentDeps) {
    super('earnings-reader', { intervalMs: 999_999 }, d);
  }
  async execute(): Promise<void> {
    if (!this.budget.allows('entry')) {
      this.log.warn(this.name, 'budget tier blocks entry calls — skipping');
      return;
    }
    const prompt =
      'Read this earnings release and reply with ONLY JSON matching ' +
      '{surpriseDirection:BEAT|MISS|INLINE|UNCLEAR, guidanceDelta:RAISED|MAINTAINED|' +
      'LOWERED|WITHDRAWN|NONE, confidence:0-100, oneLineWhy:string}.\n\n' +
      FILING;

    const r = await askClaude(prompt, { model: 'haiku', agent: this.name });
    this.log.llm(this.name, r);
    this.budget.record({
      agent: this.name, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
      costUsd: r.costUsd, latencyMs: r.latencyMs, ok: true, promptHash: r.promptHash,
    });

    const parsed = parseModelJson(r.text, Schema);
    if (!parsed.ok) {
      this.log.error(this.name, `parse failed at ${parsed.stage}: ${parsed.error}`);
      return;
    }
    const v = parsed.value;
    this.log.event(
      this.name,
      `ACME  surprise ${v.surpriseDirection}  guidance ${v.guidanceDelta}  conf ${String(v.confidence)}`,
    );
    this.log.raw(`           raw: ${JSON.stringify(r.text.slice(0, 90))}`);
    this.bus.emit({
      agent: this.name, signalType: 'earnings_read', symbol: 'ACME',
      confidence: v.confidence, data: v,
    });
  }
}

class DemoScorer extends BaseAgent {
  constructor(d: AgentDeps) {
    super('surprise-scorer', { intervalMs: 999_999 }, d);
  }
  async execute(): Promise<void> {
    const sigs = this.bus.read(['earnings_read']);
    if (sigs.length === 0) {
      this.log.warn(this.name, 'no unconsumed earnings_read signals');
      return;
    }
    for (const s of sigs) {
      const d = s.data as z.infer<typeof Schema>;
      const sue = (d.surpriseDirection === 'BEAT' ? 1.4 : 0) + (d.guidanceDelta === 'RAISED' ? 0.9 : 0);
      const verdict = sue >= 1.5 ? 'passes' : 'below';
      this.log.event(this.name, `${s.symbol ?? '?'}  SUE ${sue.toFixed(2)}  → ${verdict} gate (>= 1.50)`);
      this.bus.consume([s.id], this.name);
    }
  }
}

const db = openDb(':memory:');
const log = createLogger({ verbose: true });
const bus = new SignalBus(db);
const budget = new BudgetGovernor(db, 100, '2026-09-01');
const deps: AgentDeps = { db, bus, log, budget };

log.ok('daemon', 'end-to-end spine demo · mode=paper');
await new DemoReader(deps).tick();
await new DemoScorer(deps).tick();
log.budget(budget.spent(), 100, new Date().getDate());
const calls = db.prepare('SELECT COUNT(*) c FROM llm_calls').get() as { c: number };
log.event('daemon', `signals pending: ${String(bus.pending().length)} · llm calls logged: ${String(calls.c)}`);
