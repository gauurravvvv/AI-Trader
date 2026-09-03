import pc from 'picocolors';

export type Kind = 'event' | 'ok' | 'warn' | 'error' | 'llm';

const GLYPH: Record<Kind, string> = { event: '▸', ok: '✓', warn: '⚠', error: '✗', llm: '◆' };
const PAINT: Record<Kind, (s: string) => string> = {
  event: pc.cyan,
  ok: pc.green,
  warn: pc.yellow,
  error: pc.red,
  llm: pc.magenta,
};
// Wide enough for the longest agent name. Truncating a name makes the log
// ungreppable — "position-guardia" matches nothing you would think to search.
const AGENT_COL = 18;

/**
 * Local time, not UTC. The operator is watching their own machine and reasoning
 * about market sessions; a UTC clock in the log means doing timezone arithmetic
 * in your head while a position is open.
 */
const hhmmss = (d: Date): string =>
  [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
const num = (n: number): string => n.toLocaleString('en-US');

/**
 * Haiku calls routinely cost a few ten-thousandths of a dollar. Fixed 3-dp
 * rounds those to "$0.000", which reads as free and hides the accumulation
 * that actually drains a $100 monthly cap.
 */
export function formatCost(usd: string): string {
  const n = Number(usd);
  if (n === 0) return '$0';
  if (n < 0.001) return `$${n.toFixed(6)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatLine(o: {
  at: Date;
  agent: string;
  kind: Kind;
  msg: string;
  colour?: boolean | undefined;
}): string {
  const agent = o.agent.padEnd(AGENT_COL).slice(0, AGENT_COL);
  const body = `${GLYPH[o.kind]} ${o.msg}`;
  if (o.colour === false) return `${hhmmss(o.at)}  ${agent}${body}`;
  return `${pc.dim(hhmmss(o.at))}  ${pc.bold(agent)}${PAINT[o.kind](body)}`;
}

export function formatLlm(o: {
  at: Date;
  agent: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: string;
  latencyMs: number;
  colour?: boolean | undefined;
}): string {
  const msg =
    `${o.model}  in ${num(o.tokensIn)}  out ${num(o.tokensOut)}  ` +
    `${formatCost(o.costUsd)}  ${(o.latencyMs / 1000).toFixed(1)}s`;
  return formatLine({ at: o.at, agent: o.agent, kind: 'llm', msg, colour: o.colour });
}

export function formatBudget(o: {
  spent: string;
  budget: number;
  dayOfCycle: number;
  colour?: boolean | undefined;
}): string {
  const pct = Math.round((Number(o.spent) / o.budget) * 100);
  const line =
    `── budget: $${Number(o.spent).toFixed(2)} / $${String(o.budget)} this cycle ` +
    `(${String(pct)}%) · ${String(o.dayOfCycle)} days elapsed`;
  if (o.colour === false) return `          ${line}`;
  const paint = pct >= 85 ? pc.red : pct >= 70 ? pc.yellow : pc.dim;
  return `          ${paint(line)}`;
}
