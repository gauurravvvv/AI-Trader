import { formatLine, formatLlm, formatBudget, type Kind } from './terminal.js';

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
  raw(text: string): void;
}

export function createLogger(
  opts: {
    verbose?: boolean;
    agentFilter?: string;
    colour?: boolean;
    sink?: (line: string) => void;
  } = {},
): Logger {
  const out =
    opts.sink ??
    ((l: string): void => {
      process.stdout.write(l + '\n');
    });
  const pass = (agent: string): boolean =>
    opts.agentFilter === undefined || agent === opts.agentFilter;
  const line = (agent: string, kind: Kind, msg: string): void => {
    if (pass(agent)) out(formatLine({ at: new Date(), agent, kind, msg, colour: opts.colour }));
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
      if (pass(a)) out(formatLlm({ at: new Date(), agent: a, ...c, colour: opts.colour }));
    },
    budget: (spent, budget, dayOfCycle) => {
      out(formatBudget({ spent, budget, dayOfCycle, colour: opts.colour }));
    },
    raw: (t) => {
      if (opts.verbose === true) out(t);
    },
  };
}

export { formatLine, formatLlm, formatBudget } from './terminal.js';
export type { Kind } from './terminal.js';
