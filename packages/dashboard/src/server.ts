import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '@aegis/db';
import { isHalted, setHalt } from '@aegis/risk';
import { closedTrades, summarise } from '@aegis/pipeline';
import { equityCurve } from './equity.js';

export interface DashboardDeps {
  db: Db;
  port: number;
  monthlyBudgetUsd: number;
  autonomy: string;
  venue: string;
  onHaltChange?: (halted: boolean) => void;
}

interface Client {
  write: (chunk: string) => void;
}

/**
 * Single-operator dashboard. HTTP + Server-Sent Events, no build step and no
 * framework — the daemon should not need a bundler to show you what it is
 * doing. SSE rather than WebSocket because the stream is one-directional and
 * SSE reconnects on its own.
 */
export class Dashboard {
  private server: Server | null = null;
  private readonly clients = new Set<Client>();

  constructor(private readonly deps: DashboardDeps) {}

  /** Push an event to every connected browser. */
  broadcast(kind: string, payload: unknown): void {
    const frame = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.clients) {
      try {
        c.write(frame);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  /**
   * Lifetime result, straight from the ledger. No benchmark here: fetching SPY
   * on every three-second dashboard poll would hammer Yahoo for a number that
   * moves once a day. `pnpm report` does the comparison.
   */
  private performance(): Record<string, unknown> {
    const trades = closedTrades(this.deps.db);
    const p = summarise(trades);
    return {
      trades: p.trades,
      wins: p.wins,
      losses: p.losses,
      winRate: p.winRate,
      realised: p.realised,
      maxDrawdown: p.maxDrawdown,
      profitFactor: p.profitFactor,
      // Below this the numbers above are noise, and the UI says so rather than
      // rendering a confident-looking percentage.
      meaningful: p.trades >= 20,
    };
  }

  snapshot(): Record<string, unknown> {
    const db = this.deps.db;
    const q = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

    const cycleStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const budget = db
      .prepare('SELECT spent_usd, tier FROM budget_cycles WHERE cycle_start = ?')
      .get(cycleStart) as { spent_usd: string; tier: string } | undefined;

    return {
      halted: isHalted(db),
      autonomy: this.deps.autonomy,
      venue: this.deps.venue,
      budget: {
        spent: budget?.spent_usd ?? '0',
        cap: this.deps.monthlyBudgetUsd,
        tier: budget?.tier ?? 'NORMAL',
      },
      positions: q(
        `SELECT venue, symbol, qty, avg_cost, realised_pnl, opened_at
         FROM positions WHERE CAST(qty AS REAL) > 0 ORDER BY symbol`,
      ),
      decisions: q(
        // Sources are folded in rather than fetched per row: the reason a trade
        // was made is only reviewable next to the trade, and a decision built on
        // a synthesised spread should say so where someone will see it.
        `SELECT d.id, d.symbol, d.side, d.sue_score, d.audit_score, d.audit_tier,
                d.status, d.reject_reason, d.rationale, d.created_at,
                (SELECT GROUP_CONCAT(
                   p.kind || ':' || p.source ||
                   CASE WHEN p.reference IS NULL THEN '' ELSE ' ' || p.reference END ||
                   CASE WHEN p.degraded = 1 THEN ' [DEGRADED]' ELSE '' END, '  ·  ')
                   FROM provenance p WHERE p.decision_id = d.id) AS sources,
                (SELECT COUNT(*) FROM provenance p
                  WHERE p.decision_id = d.id AND p.degraded = 1) AS degraded
         FROM decisions d ORDER BY d.id DESC LIMIT 30`,
      ),
      orders: q(
        `SELECT o.id, o.symbol, o.side, o.qty, o.status, o.created_at, o.reject_reason
         FROM orders o ORDER BY o.id DESC LIMIT 30`,
      ),
      fills: q(
        `SELECT f.id, o.symbol, o.side, f.qty, f.price, f.fee, f.filled_at
         FROM fills f JOIN orders o ON o.id = f.order_id ORDER BY f.id DESC LIMIT 30`,
      ),
      signals: q(
        `SELECT id, agent, signal_type, symbol, confidence, consumed, consumed_by, created_at
         FROM agent_signals ORDER BY id DESC LIMIT 40`,
      ),
      // News carries a payload worth surfacing on its own: the headline is the
      // reason for the trade, and a signal list showing only "news_signal NVDA
      // 77" makes the operator open the database to find out why.
      news: q(
        `SELECT id, symbol, confidence, consumed, consumed_by, data, created_at
         FROM agent_signals WHERE signal_type = 'news_signal'
         ORDER BY id DESC LIMIT 25`,
      ).map((r) => {
        const row = r as { data: string } & Record<string, unknown>;
        let d: Record<string, unknown> = {};
        try {
          d = JSON.parse(row.data) as Record<string, unknown>;
        } catch {
          /* a malformed payload must not blank the panel */
        }
        return {
          ...row,
          data: undefined,
          title: d['title'] ?? '',
          category: d['category'] ?? '',
          direction: d['direction'] ?? 0,
          publisher: d['publisher'] ?? '',
          link: d['link'] ?? '',
          why: d['why'] ?? '',
        };
      }),
      performance: this.performance(),
      equity: equityCurve(this.deps.db),
      llmCalls: q(
        `SELECT agent, model, tokens_in, tokens_out, cost_usd, latency_ms, ok, created_at
         FROM llm_calls ORDER BY id DESC LIMIT 30`,
      ),
      agentLogs: q(
        `SELECT agent, action, symbol, details, created_at
         FROM agent_logs ORDER BY id DESC LIMIT 40`,
      ),
      costByAgent: q(
        `SELECT agent, COUNT(*) calls, SUM(CAST(cost_usd AS REAL)) cost,
                AVG(latency_ms) avg_latency
         FROM llm_calls GROUP BY agent ORDER BY cost DESC`,
      ),
    };
  }

  start(): void {
    const html = readFileSync(join(import.meta.dirname, 'ui.html'), 'utf8');

    this.server = createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/' || url.startsWith('/?')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (url === '/api/snapshot') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.snapshot()));
        return;
      }

      if (url === '/api/halt' && req.method === 'POST') {
        const next = !isHalted(this.deps.db);
        setHalt(this.deps.db, next, next ? 'dashboard kill switch' : undefined);
        this.deps.onHaltChange?.(next);
        this.broadcast('halt', { halted: next });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ halted: next }));
        return;
      }

      if (url === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
        const client: Client = { write: (c) => res.write(c) };
        this.clients.add(client);
        req.on('close', () => this.clients.delete(client));
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    this.server.listen(this.deps.port);
  }

  stop(): void {
    for (const c of this.clients) {
      try {
        c.write('event: bye\ndata: {}\n\n');
      } catch {
        /* client already gone */
      }
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }
}
