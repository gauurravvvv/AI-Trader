import type { Db } from '@aegis/db';

export type SourceKind = 'filing' | 'consensus' | 'quote' | 'news' | 'bars';

export interface Source {
  kind: SourceKind;
  source: string;
  reference?: string | undefined;
  /** When we fetched it. */
  retrievedAt?: string | undefined;
  /** When the fact was true — a filing's date, a quote's timestamp. */
  asOf?: string | undefined;
  /**
   * The fact is real but weaker than it looks: a synthetic spread, a fallback
   * SUE basis, a cached quote. Recorded so "we used a made-up spread" is
   * queryable rather than a comment in a log nobody kept.
   */
  degraded?: boolean | undefined;
  note?: string | undefined;
}

/**
 * Record what a decision was built from.
 *
 * Written in the same statement batch as the decision so a crash cannot leave a
 * trade whose reasoning has no sources. Nothing here is optional in spirit: a
 * decision that cannot name its inputs cannot be reviewed, and by the time you
 * want to know whether the spread was real, nobody remembers.
 */
export function recordProvenance(db: Db, decisionId: number, sources: Source[]): void {
  const stmt = db.prepare(
    `INSERT INTO provenance (decision_id, kind, source, reference, retrieved_at, as_of, degraded, note)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const tx = db.transaction((rows: Source[]) => {
    for (const s of rows) {
      stmt.run(
        decisionId,
        s.kind,
        s.source,
        s.reference ?? null,
        s.retrievedAt ?? null,
        s.asOf ?? null,
        s.degraded === true ? 1 : 0,
        s.note ?? null,
      );
    }
  });
  tx(sources);
}

export interface ProvenanceRow {
  kind: string;
  source: string;
  reference: string | null;
  retrieved_at: string | null;
  as_of: string | null;
  degraded: number;
  note: string | null;
}

export function provenanceFor(db: Db, decisionId: number): ProvenanceRow[] {
  return db
    .prepare('SELECT * FROM provenance WHERE decision_id = ? ORDER BY id')
    .all(decisionId) as ProvenanceRow[];
}

/** Decisions built on at least one degraded source, newest first. */
export function degradedDecisions(db: Db, limit = 50): { decision_id: number; kinds: string }[] {
  return db
    .prepare(
      `SELECT decision_id, GROUP_CONCAT(DISTINCT kind) kinds
         FROM provenance WHERE degraded = 1
         GROUP BY decision_id ORDER BY decision_id DESC LIMIT ?`,
    )
    .all(limit) as { decision_id: number; kinds: string }[];
}

export function provenanceSummary(rows: ProvenanceRow[]): string {
  if (rows.length === 0) return 'no sources recorded';
  return rows
    .map((r) => {
      const ref = r.reference === null ? '' : ` ${r.reference}`;
      const when = r.as_of === null ? '' : ` as of ${r.as_of.slice(0, 19)}`;
      return `${r.kind}:${r.source}${ref}${when}${r.degraded === 1 ? ' [DEGRADED]' : ''}`;
    })
    .join(' · ');
}
