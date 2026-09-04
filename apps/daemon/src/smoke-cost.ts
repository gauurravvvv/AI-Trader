/**
 * Prove what a call actually costs. `pnpm smoke:cost`.
 *
 * Runs three identical calls and prints the billed cost and cache health of
 * each. The first primes the cache and is expensive; calls two and three are
 * the number that matters, because that is what a running daemon pays.
 */
import { askClaude } from '@aegis/claude';
import { createLogger } from '@aegis/logger';

const log = createLogger({});
let total = 0;

for (const n of [1, 2, 3]) {
  const r = await askClaude('Reply with the single word: ok', { model: 'haiku', agent: 'smoke' });
  total += Number(r.costUsd);
  const state = r.cacheReadTokens > 0 ? `cache HIT (${String(r.cacheReadTokens)} read)` : `cache MISS (${String(r.cacheCreateTokens)} created)`;
  log.event('smoke', `call ${String(n)}: $${r.costUsd}  ${String(r.latencyMs)}ms  ${state}  measured=${String(r.costMeasured)}`);
}
log.ok('smoke', `three calls cost $${total.toFixed(6)} in total`);
log.event('smoke', 'Calls 2 and 3 are the steady state. If they show cache MISS, something is invalidating the prefix and this system is ~47x more expensive than it should be.');
