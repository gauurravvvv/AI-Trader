import Decimal from 'decimal.js';

export type ModelId = 'haiku' | 'sonnet' | 'opus';

/**
 * USD per million tokens. These are the rates programmatic `claude -p` usage is
 * billed at against the monthly credit pool — the subscription's flat rate does
 * NOT apply to non-interactive use (Anthropic billing split, 2026-06-15).
 */
export const PRICING: Record<ModelId, { in: number; out: number }> = {
  haiku: { in: 1, out: 5 }, // Haiku 4.5
  sonnet: { in: 3, out: 15 }, // Sonnet 5
  opus: { in: 5, out: 25 }, // Opus 5
};

export function estimateCost(model: ModelId, tokensIn: number, tokensOut: number): string {
  const p = PRICING[model];
  return new Decimal(tokensIn)
    .div(1_000_000)
    .times(p.in)
    .plus(new Decimal(tokensOut).div(1_000_000).times(p.out))
    .toFixed(6);
}

/**
 * The CLI does not report token counts, so approximate at ~4 chars/token.
 * Deliberately rounds up: better to believe we spent more than we did and stop
 * early than to overrun a hard cap.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
