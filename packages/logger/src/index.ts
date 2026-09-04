import { formatLine, formatLlm, formatBudget, type Kind } from './terminal.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';

/** Which kinds survive at each level. */
const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const KIND_RANK: Record<Kind, number> = {
  event: 1, ok: 1, llm: 1, warn: 2, error: 3,
};

export interface Logger {
  event(agent: string, msg: string): void;
  ok(agent: string, msg: string): void;
  warn(agent: string, msg: string): void;
  error(agent: string, msg: string): void;
  llm(
    agent: string,
    c: { model: string; tokensIn: number; tokensOut: number; costUsd: string; latencyMs: number },
  ): void;
  budget(spent: string, budget: number, dayOfCycle: number): void;
  /** Writes text exactly as given. Always printed — this is content, not chatter. */
  raw(text: string): void;
  /** Verbose-only diagnostic chatter. */
  debug(text: string): void;
}

export function createLogger(
  opts: {
    level?: Level;
    verbose?: boolean;
    agentFilter?: string;
    colour?: boolean;
    sink?: (line: string) => void;
  } = {},
): Logger {
  const minRank = RANK[opts.level ?? 'info'];
  const out =
    opts.sink ??
    ((l: string): void => {
      process.stdout.write(l + '\n');
    });
  const pass = (agent: string, kind: Kind): boolean =>
    (opts.agentFilter === undefined || agent === opts.agentFilter) &&
    KIND_RANK[kind] >= minRank;
  const line = (agent: string, kind: Kind, msg: string): void => {
    if (pass(agent, kind)) out(formatLine({ at: new Date(), agent, kind, msg, colour: opts.colour }));
  };
  return {
    event: (a, m) => {
      line(a, 'event', m);
    },
    ok: (a, m) => {
      line(a, 'ok', m);
    },
    warn: (a, m) => {
      line(a, 'warn', m);
    },
    error: (a, m) => {
      line(a, 'error', m);
    },
    llm: (a, c) => {
      if (pass(a, 'llm')) out(formatLlm({ at: new Date(), agent: a, ...c, colour: opts.colour }));
    },
    budget: (spent, budget, dayOfCycle) => {
      out(formatBudget({ spent, budget, dayOfCycle, colour: opts.colour }));
    },
    // Unconditional. Both callers write content that IS the message — the body
    // of a notification and the performance report — and gating them on
    // --verbose meant the default console "email" transport delivered a subject
    // line and silently dropped everything under it.
    raw: (t) => {
      out(t);
    },
    debug: (t) => {
      if (opts.verbose === true) out(t);
    },
  };
}

export { formatLine, formatLlm, formatBudget } from './terminal.js';
export type { Kind } from './terminal.js';
