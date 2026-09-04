import Decimal from 'decimal.js';
import { z } from 'zod';
import type { Db } from '@aegis/db';

/**
 * A condition that would falsify the reason a position was opened.
 *
 * Structured rather than prose. Every decision already carried a `thesis_break`
 * field, and every one of them held sentences like "guidance is lowered or
 * withdrawn at the next report" — true, useful to a human, and impossible for
 * the guardian to evaluate. So it never did, and the column was written on
 * every decision and read by nothing.
 *
 * These are checkable without a model, which is what lets the guardian act on
 * them at RULES_ONLY and at three in the morning.
 */
export const WatchConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PRICE_BELOW'), value: z.string(), why: z.string() }),
  z.object({ kind: z.literal('PRICE_ABOVE'), value: z.string(), why: z.string() }),
  z.object({ kind: z.literal('DAYS_ELAPSED'), value: z.number().int().positive(), why: z.string() }),
  z.object({ kind: z.literal('NEW_FILING'), why: z.string() }),
  z.object({
    kind: z.literal('CONTRADICTING_NEWS'),
    minMateriality: z.number().min(0).max(100),
    why: z.string(),
  }),
]);

export type WatchCondition = z.infer<typeof WatchConditionSchema>;

export interface WatchContext {
  price: string;
  heldDays: number;
  /** A new earnings filing has arrived for this symbol since entry. */
  newFilingSinceEntry: boolean;
  /** Strongest opposing news materiality since entry, 0 when none. */
  opposingNewsMateriality: number;
}

export interface WatchBreak {
  broken: boolean;
  condition: WatchCondition | null;
  detail: string;
}

/**
 * First condition that fires wins.
 *
 * Order is the order they were written, so the most important reason a thesis
 * could fail should be listed first by whoever wrote it.
 */
export function evaluateWatch(conditions: WatchCondition[], ctx: WatchContext): WatchBreak {
  for (const c of conditions) {
    switch (c.kind) {
      case 'PRICE_BELOW':
        if (new Decimal(ctx.price).lt(c.value)) {
          return { broken: true, condition: c, detail: `${ctx.price} below ${c.value} — ${c.why}` };
        }
        break;
      case 'PRICE_ABOVE':
        if (new Decimal(ctx.price).gt(c.value)) {
          return { broken: true, condition: c, detail: `${ctx.price} above ${c.value} — ${c.why}` };
        }
        break;
      case 'DAYS_ELAPSED':
        if (ctx.heldDays >= c.value) {
          return {
            broken: true,
            condition: c,
            detail: `held ${String(ctx.heldDays)}d, limit ${String(c.value)}d — ${c.why}`,
          };
        }
        break;
      case 'NEW_FILING':
        if (ctx.newFilingSinceEntry) {
          return { broken: true, condition: c, detail: `a new filing landed — ${c.why}` };
        }
        break;
      case 'CONTRADICTING_NEWS':
        if (ctx.opposingNewsMateriality >= c.minMateriality) {
          return {
            broken: true,
            condition: c,
            detail: `opposing news at materiality ${String(ctx.opposingNewsMateriality)} — ${c.why}`,
          };
        }
        break;
    }
  }
  return { broken: false, condition: null, detail: 'thesis intact' };
}

/**
 * Read a decision's conditions.
 *
 * Rows written before conditions were structured hold an array of sentences.
 * Those are returned as an empty list and reported, rather than silently
 * treated as "no conditions" — a position whose thesis cannot be checked is a
 * different thing from a position with nothing to check.
 */
export function readConditions(raw: string | null): {
  conditions: WatchCondition[];
  unevaluable: number;
} {
  if (raw === null || raw.trim() === '') return { conditions: [], unevaluable: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { conditions: [], unevaluable: 0 };
  }
  if (!Array.isArray(parsed)) return { conditions: [], unevaluable: 0 };

  const conditions: WatchCondition[] = [];
  let unevaluable = 0;
  for (const row of parsed) {
    const r = WatchConditionSchema.safeParse(row);
    if (r.success) conditions.push(r.data);
    else unevaluable += 1;
  }
  return { conditions, unevaluable };
}

/** Standard conditions for a post-earnings-drift entry. */
export function driftConditions(entryPrice: string, timeStopDays: number): WatchCondition[] {
  const entry = new Decimal(entryPrice);
  return [
    {
      kind: 'NEW_FILING',
      why: 'the next report supersedes the surprise this position was opened on',
    },
    {
      kind: 'CONTRADICTING_NEWS',
      minMateriality: 70,
      why: 'a material story pointing the other way falsifies the read',
    },
    {
      kind: 'PRICE_BELOW',
      value: entry.times(0.92).toFixed(2),
      why: 'the drift did not materialise',
    },
    {
      kind: 'DAYS_ELAPSED',
      value: timeStopDays,
      why: 'the drift window has closed',
    },
  ];
}

/** Standard conditions for a news-driven entry. */
export function newsConditions(entryPrice: string, direction: number): WatchCondition[] {
  const entry = new Decimal(entryPrice);
  return [
    {
      kind: 'CONTRADICTING_NEWS',
      minMateriality: 60,
      why: 'the story was corrected, denied, or outweighed',
    },
    {
      kind: direction >= 0 ? 'PRICE_BELOW' : 'PRICE_ABOVE',
      value: (direction >= 0 ? entry.times(0.94) : entry.times(1.06)).toFixed(2),
      why: 'the market moved against the story rather than with it',
    },
    {
      kind: 'DAYS_ELAPSED',
      value: 10,
      why: 'a news reaction that has not played out in ten sessions is not going to',
    },
  ];
}

/**
 * Has a newer earnings filing arrived for this symbol since the position opened?
 *
 * Reads the signal bus rather than EDGAR: the poller has already recorded every
 * filing it saw, so this costs a query rather than a network round trip.
 */
export function newFilingSince(db: Db, symbol: string, sinceIso: string): boolean {
  const r = db
    .prepare(
      // datetime() on both sides on purpose. The ledger stamps opened_at with
      // JavaScript's ISO format (2026-09-04T13:20:00.000Z) while the signal bus
      // defaults to SQLite's datetime('now') (2026-09-04 13:20:00). Compared as
      // strings, ' ' sorts below 'T', so every comparison silently returned
      // false and no thesis condition depending on time could ever fire.
      `SELECT COUNT(*) c FROM agent_signals
        WHERE signal_type = 'filing_8k' AND symbol = ?
          AND datetime(created_at) > datetime(?)`,
    )
    .get(symbol, sinceIso) as { c: number };
  return r.c > 0;
}

/**
 * Strongest opposing news materiality since entry.
 *
 * `held` is the side we are on. A long position is contradicted by negative
 * news; the sign matters, and news that agrees with us is not a thesis break
 * however loud it is.
 */
export function opposingNewsSince(
  db: Db,
  symbol: string,
  sinceIso: string,
  side: 'long' | 'short' = 'long',
): number {
  const rows = db
    .prepare(
      // See newFilingSince: the two timestamp formats do not compare as strings.
      `SELECT data FROM agent_signals
        WHERE signal_type = 'news_signal' AND symbol = ?
          AND datetime(created_at) > datetime(?)`,
    )
    .all(symbol, sinceIso) as { data: string }[];

  let worst = 0;
  for (const row of rows) {
    try {
      const d = JSON.parse(row.data) as { direction?: number; materiality?: number };
      const dir = d.direction ?? 0;
      const mat = d.materiality ?? 0;
      const opposes = side === 'long' ? dir < 0 : dir > 0;
      if (opposes && mat > worst) worst = mat;
    } catch {
      /* a malformed payload is not evidence */
    }
  }
  return worst;
}
