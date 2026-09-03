import type { Db } from '@aegis/db';

export interface Signal {
  id: number;
  agent: string;
  signalType: string;
  symbol: string | null;
  confidence: number | null;
  data: Record<string, unknown>;
  consumed: boolean;
  consumedBy: string | null;
  consumedAt: string | null;
  createdAt: string;
}

export interface EmitInput {
  agent: string;
  signalType: string;
  symbol?: string;
  confidence?: number;
  data?: Record<string, unknown>;
}

interface Row {
  id: number;
  agent: string;
  signal_type: string;
  symbol: string | null;
  confidence: number | null;
  data: string;
  consumed: number;
  consumed_by: string | null;
  consumed_at: string | null;
  created_at: string;
}

function hydrate(r: Row): Signal {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(r.data) as Record<string, unknown>;
  } catch {
    /* keep {} — a malformed payload must not break the reader */
  }
  return {
    id: r.id,
    agent: r.agent,
    signalType: r.signal_type,
    symbol: r.symbol,
    confidence: r.confidence,
    data,
    consumed: r.consumed === 1,
    consumedBy: r.consumed_by,
    consumedAt: r.consumed_at,
    createdAt: r.created_at,
  };
}

/**
 * Durable producer/consumer bus. Deliberately a table rather than in-process
 * events: it survives a crash mid-tick, every message is inspectable from the
 * dashboard, and a consumer that dies does not silently lose work.
 */
export class SignalBus {
  constructor(private readonly db: Db) {}

  emit(s: EmitInput): number {
    const info = this.db
      .prepare(
        'INSERT INTO agent_signals (agent, signal_type, symbol, confidence, data) VALUES (?,?,?,?,?)',
      )
      .run(
        s.agent,
        s.signalType,
        s.symbol ?? null,
        s.confidence ?? null,
        JSON.stringify(s.data ?? {}),
      );
    return Number(info.lastInsertRowid);
  }

  read(signalTypes: string[], limit = 100): Signal[] {
    if (signalTypes.length === 0) return [];
    const ph = signalTypes.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_signals WHERE consumed = 0 AND signal_type IN (${ph})
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...signalTypes, limit) as Row[];
    return rows.map(hydrate);
  }

  consume(ids: number[], by: string): void {
    if (ids.length === 0) return; // an empty IN () is a syntax error
    const ph = ids.map(() => '?').join(',');
    this.db
      .prepare(
        `UPDATE agent_signals SET consumed = 1, consumed_by = ?, consumed_at = datetime('now')
         WHERE id IN (${ph})`,
      )
      .run(by, ...ids);
  }

  byId(id: number): Signal | null {
    const r = this.db.prepare('SELECT * FROM agent_signals WHERE id = ?').get(id) as
      | Row
      | undefined;
    return r ? hydrate(r) : null;
  }

  pending(limit = 200): Signal[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_signals WHERE consumed = 0 ORDER BY id DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map(hydrate);
  }
}
