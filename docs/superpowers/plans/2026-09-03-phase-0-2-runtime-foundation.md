# Phases 0–2: Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daemon that starts with one command, runs staggered agents off a durable SQLite signal bus, calls Claude through the local `claude -p` CLI with accurate per-call cost accounting against a hard monthly budget, and streams a detailed colour-coded log to the terminal.

**Architecture:** TypeScript monorepo, SQLite via `better-sqlite3`, no Docker or external services. `packages/config` owns fail-loud env parsing and the frozen paper-endpoint allowlist. `packages/db` owns schema and migrations. `packages/claude` owns the CLI subprocess wrapper, the tolerant parser and cost estimation. `packages/budget` owns the spend ledger and tier governor. `packages/agents` owns the signal bus, `BaseAgent` and the orchestrator. `packages/logger` owns the terminal renderer. No trading logic and no venue adapters in these phases.

**Tech Stack:** TypeScript 5.6+, Node ≥20, pnpm workspaces, Vitest, better-sqlite3, Zod, picocolors, decimal.js.

**Spec:** [`docs/superpowers/specs/2026-09-03-aegis-design.md`](../specs/2026-09-03-aegis-design.md)

## Global Constraints

- **INV-1 — paper money only.** `TRADING_MODE` accepts only the literal `paper`. Venue URLs come from a frozen `PAPER_ENDPOINTS` allowlist. No live broker hostname may appear anywhere in source; a test enforces this.
- **INV-4 — risk limits are deterministic code.** No LLM call may appear in any package that gates an order. (Enforced from Phase 3; do not add one here.)
- **Budget is a hard cap.** Every `claude` invocation records model, tokens, cost, latency and agent *before* its result is used. Spend tiers degrade behaviour; they never crash the daemon.
- **No fabricated numbers.** Parsed model output is Zod-validated. A field that cannot be validated becomes `null` plus a `dataGaps` entry — never a guess.
- **Money is `decimal.js` or integer minor units.** Never a raw JS `number` for a persisted price, quantity or cost.
- `strict: true`, `noUncheckedIndexedAccess: true`. Every package exports only from `src/index.ts`.
- Every task ends with a green `pnpm vitest run` and a commit.

---

### Task 1: Monorepo skeleton and fail-loud config

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc`
- Create: `packages/config/package.json`, `packages/config/src/index.ts`, `packages/config/src/env.ts`
- Test: `packages/config/src/env.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig` throwing `ConfigError`. `AppConfig = { tradingMode: 'paper'; dbPath: string; logLevel: 'debug'|'info'|'warn'|'error'; verbose: boolean; monthlyBudgetUsd: number; auditFloor: number; claudeConcurrency: number; sueThreshold: number; dashboardPort: number }`.

- [ ] **Step 1: Scaffold the workspace**

```bash
mkdir -p packages/config/src
printf '20\n' > .nvmrc
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - 'packages/*'
  - 'apps/*'
EOF
```

```json
// package.json
{
  "name": "aegis",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b",
    "dev": "node --import tsx apps/daemon/src/main.ts"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 2: Write the failing config test**

```typescript
// packages/config/src/env.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from './env.js';

const base = { TRADING_MODE: 'paper', DB_PATH: './data/aegis.db' };

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const c = loadConfig(base);
    expect(c.tradingMode).toBe('paper');
    expect(c.monthlyBudgetUsd).toBe(100);
    expect(c.claudeConcurrency).toBe(3);
    expect(c.sueThreshold).toBe(1.5);
  });

  it('rejects any TRADING_MODE other than the literal "paper" (INV-1)', () => {
    for (const bad of ['live', 'PAPER', 'Paper', '']) {
      expect(() => loadConfig({ ...base, TRADING_MODE: bad })).toThrow(ConfigError);
    }
  });

  it('fails loud on a malformed boolean instead of defaulting', () => {
    expect(() => loadConfig({ ...base, VERBOSE: 'treu' })).toThrow(/VERBOSE/);
  });

  it('fails loud on a non-numeric budget', () => {
    expect(() => loadConfig({ ...base, MONTHLY_BUDGET_USD: 'lots' })).toThrow(/MONTHLY_BUDGET_USD/);
  });

  it('rejects a budget outside sane bounds', () => {
    expect(() => loadConfig({ ...base, MONTHLY_BUDGET_USD: '0' })).toThrow(/MONTHLY_BUDGET_USD/);
    expect(() => loadConfig({ ...base, MONTHLY_BUDGET_USD: '99999' })).toThrow(/MONTHLY_BUDGET_USD/);
  });

  it('rejects a claude concurrency above 8 — each call is a full node process', () => {
    expect(() => loadConfig({ ...base, CLAUDE_CONCURRENCY: '50' })).toThrow(/CLAUDE_CONCURRENCY/);
  });

  it('throws when a required variable is missing', () => {
    expect(() => loadConfig({ TRADING_MODE: 'paper' })).toThrow(/DB_PATH/);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run packages/config`
Expected: FAIL — `Cannot find module './env.js'`

- [ ] **Step 4: Implement the loader**

```typescript
// packages/config/src/env.ts
export class ConfigError extends Error {
  constructor(key: string, detail: string) {
    super(`Invalid configuration for ${key}: ${detail}`);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  tradingMode: 'paper';
  dbPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  verbose: boolean;
  monthlyBudgetUsd: number;
  auditFloor: number;
  claudeConcurrency: number;
  sueThreshold: number;
  dashboardPort: number;
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') throw new ConfigError(key, 'is required but was not set');
  return v;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined) return fallback;
  const n = v.trim().toLowerCase();
  if (TRUE.has(n)) return true;
  if (FALSE.has(n)) return false;
  throw new ConfigError(key, `expected a boolean, got ${JSON.stringify(v)}`);
}

function num(
  env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number, int = false,
): number {
  const v = env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(key, `expected a number, got ${JSON.stringify(v)}`);
  if (int && !Number.isInteger(n)) throw new ConfigError(key, `expected an integer, got ${n}`);
  if (n < min || n > max) throw new ConfigError(key, `expected ${min}-${max}, got ${n}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // INV-1. Case-sensitive on purpose: "Paper" is a typo, not an intent.
  const mode = required(env, 'TRADING_MODE');
  if (mode !== 'paper') {
    throw new ConfigError('TRADING_MODE', `only "paper" is permitted (INV-1); got ${JSON.stringify(mode)}`);
  }

  const level = env.LOG_LEVEL ?? 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new ConfigError('LOG_LEVEL', `expected one of ${LOG_LEVELS.join('/')}, got ${JSON.stringify(level)}`);
  }

  return {
    tradingMode: 'paper',
    dbPath: required(env, 'DB_PATH'),
    logLevel: level as AppConfig['logLevel'],
    verbose: bool(env, 'VERBOSE', false),
    monthlyBudgetUsd: num(env, 'MONTHLY_BUDGET_USD', 100, 1, 10_000),
    auditFloor: num(env, 'AUDIT_FLOOR', 70, 0, 100, true),
    // Each claude call is a full node process. Above ~8 the machine thrashes.
    claudeConcurrency: num(env, 'CLAUDE_CONCURRENCY', 3, 1, 8, true),
    sueThreshold: num(env, 'SUE_THRESHOLD', 1.5, 0, 10),
    dashboardPort: num(env, 'DASHBOARD_PORT', 3777, 1024, 65_535, true),
  };
}
```

```typescript
// packages/config/src/index.ts
export { loadConfig, ConfigError } from './env.js';
export type { AppConfig } from './env.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/config`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .nvmrc packages/config
git commit -m "feat(config): fail-loud env parsing, paper-only TRADING_MODE (INV-1)"
```

---

### Task 2: Frozen paper-endpoint allowlist and the live-hostname build guard

**Files:**
- Create: `packages/config/src/endpoints.ts`
- Modify: `packages/config/src/index.ts`
- Test: `packages/config/src/endpoints.test.ts`, `packages/config/src/no-live-endpoints.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type VenueId = 'alpaca-paper' | 'binance-testnet' | 'india-sim'`, `type MarketId = 'US' | 'CRYPTO' | 'IN'`, `PAPER_ENDPOINTS`, `VENUE_MARKET`, `resolveEndpoint(v: VenueId): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/config/src/endpoints.test.ts
import { describe, it, expect } from 'vitest';
import { PAPER_ENDPOINTS, VENUE_MARKET, resolveEndpoint } from './endpoints.js';

describe('PAPER_ENDPOINTS', () => {
  it('contains exactly the three paper venues', () => {
    expect(Object.keys(PAPER_ENDPOINTS).sort())
      .toEqual(['alpaca-paper', 'binance-testnet', 'india-sim']);
  });

  it('maps US to Alpaca paper', () => {
    expect(resolveEndpoint('alpaca-paper')).toBe('https://paper-api.alpaca.markets');
    expect(VENUE_MARKET['alpaca-paper']).toBe('US');
  });

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(PAPER_ENDPOINTS)).toBe(true);
  });

  it('throws on an unknown venue rather than returning undefined', () => {
    // @ts-expect-error deliberately invalid
    expect(() => resolveEndpoint('alpaca-live')).toThrow(/unknown venue/i);
  });
});
```

```typescript
// packages/config/src/no-live-endpoints.test.ts
// INV-1 build guard: a live broker hostname must never appear in our source.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

const FORBIDDEN = [
  'api.alpaca.markets',   // Alpaca LIVE
  'api.binance.com',      // Binance LIVE
  'fapi.binance.com',     // Binance LIVE futures
  'api.kite.trade',       // Zerodha LIVE
];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'reference', 'coverage', 'data']);
const EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.yaml', '.yml']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.has(extname(e))) out.push(full);
  }
  return out;
}

describe('INV-1: no live broker endpoints in source', () => {
  it('finds no forbidden hostname', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const offenders: string[] = [];
    for (const file of walk(root)) {
      if (file.endsWith('no-live-endpoints.test.ts')) continue;  // names them legitimately
      const text = readFileSync(file, 'utf8');
      for (const host of FORBIDDEN) if (text.includes(host)) offenders.push(`${file} :: ${host}`);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run packages/config/src/endpoints`
Expected: FAIL — `Cannot find module './endpoints.js'`

- [ ] **Step 3: Implement**

```typescript
// packages/config/src/endpoints.ts
export type VenueId = 'alpaca-paper' | 'binance-testnet' | 'india-sim';
export type MarketId = 'US' | 'CRYPTO' | 'IN';

/**
 * INV-1: the complete, frozen set of endpoints this system may ever reach.
 * Adding a live host here is a licence to lose money and must be rejected in
 * review. `no-live-endpoints.test.ts` fails the build if one appears anywhere.
 */
export const PAPER_ENDPOINTS = Object.freeze({
  'alpaca-paper': 'https://paper-api.alpaca.markets',
  'binance-testnet': 'https://testnet.binance.vision',
  'india-sim': 'internal://india-sim',
} as const satisfies Record<VenueId, string>);

export const VENUE_MARKET = Object.freeze({
  'alpaca-paper': 'US',
  'binance-testnet': 'CRYPTO',
  'india-sim': 'IN',
} as const satisfies Record<VenueId, MarketId>);

export function resolveEndpoint(venue: VenueId): string {
  const url = PAPER_ENDPOINTS[venue];
  if (url === undefined) throw new Error(`Unknown venue: ${String(venue)}`);
  return url;
}
```

Append to `packages/config/src/index.ts`:

```typescript
export { PAPER_ENDPOINTS, VENUE_MARKET, resolveEndpoint } from './endpoints.js';
export type { VenueId, MarketId } from './endpoints.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/config`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add packages/config
git commit -m "feat(config): frozen paper-endpoint allowlist + live-hostname build guard (INV-1)"
```

---

### Task 3: SQLite schema and migrations

**Files:**
- Create: `packages/db/package.json`, `packages/db/src/index.ts`, `packages/db/src/schema.sql`, `packages/db/src/db.ts`
- Test: `packages/db/src/db.test.ts`

**Interfaces:**
- Consumes: `AppConfig.dbPath`
- Produces: `openDb(path: string): Db` — a better-sqlite3 handle with migrations applied, WAL on, foreign keys on — and the tables `agent_signals`, `agent_logs`, `llm_calls`, `budget_cycles`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/db/src/db.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from './db.js';

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });

describe('openDb', () => {
  it('creates all core tables', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]).map((r) => r.name);
    for (const t of ['agent_signals', 'agent_logs', 'llm_calls', 'budget_cycles', '_migrations']) {
      expect(names).toContain(t);
    }
  });

  it('enables foreign keys', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('records the migration exactly once even if applied twice', () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM _migrations').get() as { c: number }).c;
    db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run('001_initial');
    const after = (db.prepare('SELECT COUNT(*) c FROM _migrations').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('agent_signals defaults to unconsumed', () => {
    db.prepare(`INSERT INTO agent_signals (agent, signal_type, symbol, confidence, data)
                VALUES (?,?,?,?,?)`).run('news-triage', 'bullish_news', 'NVDA', 70, '{}');
    const row = db.prepare('SELECT * FROM agent_signals').get() as
      { consumed: number; consumed_by: string | null };
    expect(row.consumed).toBe(0);
    expect(row.consumed_by).toBeNull();
  });

  it('llm_calls stores cost with enough precision for sub-cent calls', () => {
    db.prepare(`INSERT INTO llm_calls (agent, model, tokens_in, tokens_out, cost_usd, latency_ms, ok)
                VALUES (?,?,?,?,?,?,?)`).run('news-triage', 'haiku', 2000, 200, '0.003000', 6200, 1);
    const row = db.prepare('SELECT cost_usd FROM llm_calls').get() as { cost_usd: string };
    expect(Number(row.cost_usd)).toBeCloseTo(0.003, 6);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/db`
Expected: FAIL — `Cannot find module './db.js'`

- [ ] **Step 3: Write the schema**

```sql
-- packages/db/src/schema.sql
CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Durable producer/consumer bus between agents. Ported from the TradeEase POC:
-- chosen over in-process events because it survives a crash, is inspectable in
-- the UI, and gives every message an audit trail.
CREATE TABLE IF NOT EXISTS agent_signals (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  symbol TEXT,
  confidence REAL,
  data TEXT NOT NULL DEFAULT '{}',          -- JSON payload
  consumed INTEGER NOT NULL DEFAULT 0,
  consumed_by TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_unconsumed
  ON agent_signals (consumed, signal_type, created_at);

CREATE TABLE IF NOT EXISTS agent_logs (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  symbol TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_agent_time ON agent_logs (agent, created_at DESC);

-- Every claude invocation, recorded before its result is used.
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd TEXT NOT NULL,                   -- decimal string, never a float
  latency_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  prompt_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_time ON llm_calls (created_at DESC);

-- One row per monthly credit cycle, so spend and tier survive a restart.
CREATE TABLE IF NOT EXISTS budget_cycles (
  id INTEGER PRIMARY KEY,
  cycle_start TEXT NOT NULL UNIQUE,         -- ISO date, first day of the cycle
  budget_usd TEXT NOT NULL,
  spent_usd TEXT NOT NULL DEFAULT '0',
  tier TEXT NOT NULL DEFAULT 'NORMAL',      -- NORMAL | CONSERVE | ESSENTIAL | RULES_ONLY
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Implement the opener**

```typescript
// packages/db/src/db.ts
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Agents write concurrently from timers; without this a slow write throws
  // SQLITE_BUSY instead of waiting for the lock.
  db.pragma('busy_timeout = 5000');

  const sql = readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run('001_initial');
  return db;
}
```

```typescript
// packages/db/src/index.ts
export { openDb } from './db.js';
export type { Db } from './db.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/db`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): SQLite schema — signal bus, agent logs, llm_calls, budget cycles"
```

---

### Task 4: Cost estimation

**Files:**
- Create: `packages/claude/package.json`, `packages/claude/src/pricing.ts`
- Test: `packages/claude/src/pricing.test.ts`

**Interfaces:**
- Consumes: `decimal.js`
- Produces: `type ModelId = 'haiku' | 'sonnet' | 'opus'`, `PRICING`, `estimateCost(model, tokensIn, tokensOut): string`, `estimateTokens(text): number`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/claude/src/pricing.test.ts
import { describe, it, expect } from 'vitest';
import { estimateCost, estimateTokens } from './pricing.js';

describe('estimateCost', () => {
  it('prices haiku at $1/$5 per million', () => {
    expect(Number(estimateCost('haiku', 1_000_000, 1_000_000))).toBeCloseTo(6, 6);
  });

  it('prices sonnet at $3/$15 per million', () => {
    expect(Number(estimateCost('sonnet', 1_000_000, 1_000_000))).toBeCloseTo(18, 6);
  });

  it('prices a realistic earnings read near nine cents', () => {
    // 20k filing in, 1.2k structured out, sonnet
    const c = Number(estimateCost('sonnet', 20_000, 1_200));
    expect(c).toBeGreaterThan(0.07);
    expect(c).toBeLessThan(0.10);
  });

  it('returns a decimal string, never a float', () => {
    expect(typeof estimateCost('haiku', 1000, 100)).toBe('string');
  });
});

describe('estimateTokens', () => {
  it('estimates at roughly four characters per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('never returns zero for non-empty text', () => {
    expect(estimateTokens('hi')).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/claude`
Expected: FAIL — `Cannot find module './pricing.js'`

- [ ] **Step 3: Implement**

```typescript
// packages/claude/src/pricing.ts
import Decimal from 'decimal.js';

export type ModelId = 'haiku' | 'sonnet' | 'opus';

/**
 * USD per million tokens. These are the rates programmatic `claude -p` usage is
 * billed at against the monthly credit pool — the subscription's flat rate does
 * NOT apply to non-interactive use (Anthropic billing split, 2026-06-15).
 */
export const PRICING: Record<ModelId, { in: number; out: number }> = {
  haiku:  { in: 1, out: 5 },    // Haiku 4.5
  sonnet: { in: 3, out: 15 },   // Sonnet 5
  opus:   { in: 5, out: 25 },   // Opus 5
};

export function estimateCost(model: ModelId, tokensIn: number, tokensOut: number): string {
  const p = PRICING[model];
  return new Decimal(tokensIn).div(1_000_000).times(p.in)
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/claude`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add packages/claude
git commit -m "feat(claude): API-rate cost estimation for metered claude -p usage"
```

---

### Task 5: The `claude -p` subprocess runtime

**Files:**
- Create: `packages/claude/src/cli.ts`, `packages/claude/src/index.ts`
- Test: `packages/claude/src/cli.test.ts`

**Interfaces:**
- Consumes: `estimateCost`, `estimateTokens`, `ModelId` from Task 4
- Produces: `askClaude(prompt: string, opts: AskOpts): Promise<ClaudeResult>`, `buildArgs(model, prompt): string[]`, `sanitiseEnv(env): NodeJS.ProcessEnv`, `setConcurrency(n): void`, `ClaudeError`. `AskOpts = { model: ModelId; agent: string; timeoutMs?: number }`. `ClaudeResult = { text; tokensIn; tokensOut; costUsd; latencyMs; promptHash }`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/claude/src/cli.test.ts
import { describe, it, expect } from 'vitest';
import { buildArgs, sanitiseEnv } from './cli.js';

describe('buildArgs', () => {
  it('uses --print and passes the model', () => {
    expect(buildArgs('sonnet', 'hello')).toEqual(['--print', '--model', 'sonnet', '-p', 'hello']);
  });
});

describe('sanitiseEnv', () => {
  it('deletes CLAUDECODE and CLAUDE_CODE so the child is not seen as nested', () => {
    const env = sanitiseEnv({ PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE: '1', HOME: '/h' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/h');
  });

  it('does not mutate the input', () => {
    const src = { CLAUDECODE: '1' };
    sanitiseEnv(src);
    expect(src.CLAUDECODE).toBe('1');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/claude/src/cli`
Expected: FAIL — `Cannot find module './cli.js'`

- [ ] **Step 3: Implement**

```typescript
// packages/claude/src/cli.ts
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { estimateCost, estimateTokens, type ModelId } from './pricing.js';

export interface AskOpts { model: ModelId; agent: string; timeoutMs?: number }
export interface ClaudeResult {
  text: string; tokensIn: number; tokensOut: number;
  costUsd: string; latencyMs: number; promptHash: string;
}

export class ClaudeError extends Error {
  constructor(msg: string, readonly code: 'TIMEOUT' | 'EXIT' | 'SPAWN', readonly stderr = '') {
    super(msg);
    this.name = 'ClaudeError';
  }
}

export function buildArgs(model: ModelId, prompt: string): string[] {
  return ['--print', '--model', model, '-p', prompt];
}

/**
 * Claude Code refuses to run nested inside itself. When the daemon is launched
 * from a Claude Code session these variables are set and the child detects a
 * nested session. Discovered the hard way in the TradeEase POC.
 */
export function sanitiseEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...src };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  return env;
}

// Each invocation is a full node process. Measured cold latency on the target
// machine: haiku 6.2s, sonnet 17.8s. Unbounded fan-out thrashes the machine
// long before it improves throughput.
let inFlight = 0;
let maxConcurrent = 3;
const waiting: (() => void)[] = [];

export function setConcurrency(n: number): void { maxConcurrent = n; }

async function acquire(): Promise<void> {
  if (inFlight < maxConcurrent) { inFlight++; return; }
  await new Promise<void>((r) => waiting.push(r));
  inFlight++;
}

function release(): void {
  inFlight--;
  waiting.shift()?.();
}

export async function askClaude(prompt: string, opts: AskOpts): Promise<ClaudeResult> {
  await acquire();
  const started = Date.now();
  try {
    const text = await run(prompt, opts);
    const tokensIn = estimateTokens(prompt);
    const tokensOut = estimateTokens(text);
    return {
      text,
      tokensIn,
      tokensOut,
      costUsd: estimateCost(opts.model, tokensIn, tokensOut),
      latencyMs: Date.now() - started,
      promptHash: createHash('sha256').update(prompt).digest('hex').slice(0, 16),
    };
  } finally {
    release();
  }
}

function run(prompt: string, opts: AskOpts): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const child = spawn('claude', buildArgs(opts.model, prompt), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitiseEnv(process.env),
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000);
      hard.unref();
      reject(new ClaudeError(`claude timed out after ${timeoutMs}ms`, 'TIMEOUT', stderr));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new ClaudeError(`claude exited ${code}`, 'EXIT', stderr.trim()));
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ClaudeError(`claude spawn failed: ${e.message}`, 'SPAWN'));
    });
  });
}
```

```typescript
// packages/claude/src/index.ts
export { askClaude, buildArgs, sanitiseEnv, setConcurrency, ClaudeError } from './cli.js';
export type { AskOpts, ClaudeResult } from './cli.js';
export { estimateCost, estimateTokens, PRICING } from './pricing.js';
export type { ModelId } from './pricing.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/claude`
Expected: PASS, 9 tests

- [ ] **Step 5: Prove it against the real CLI**

```bash
node --import tsx -e "
import { askClaude } from './packages/claude/src/index.ts';
const r = await askClaude('Reply with exactly: {\"ok\":true}', { model: 'haiku', agent: 'smoke' });
console.log(r);
"
```

Expected: a `ClaudeResult` with non-zero `tokensIn`/`tokensOut`, `costUsd` near `0.000100`, and `latencyMs` between roughly 4000 and 12000. The text may arrive fence-wrapped — Task 6 handles that.

- [ ] **Step 6: Commit**

```bash
git add packages/claude
git commit -m "feat(claude): claude -p subprocess runtime with nested-session guard and concurrency cap"
```

---

### Task 6: Tolerant JSON parser with schema validation

**Files:**
- Create: `packages/claude/src/parse.ts`
- Modify: `packages/claude/src/index.ts`
- Test: `packages/claude/src/parse.test.ts`

**Interfaces:**
- Consumes: `zod`
- Produces: `parseModelJson<T>(raw: string, schema: ZodType<T>): ParseResult<T>` where `ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; stage: ParseStage }` and `ParseStage = 'direct' | 'fence' | 'extract' | 'schema'`.

- [ ] **Step 1: Write the failing test**

````typescript
// packages/claude/src/parse.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseModelJson } from './parse.js';

const S = z.object({ ok: z.boolean(), n: z.number() });

describe('parseModelJson', () => {
  it('parses clean JSON', () => {
    expect(parseModelJson('{"ok":true,"n":7}', S)).toEqual({ ok: true, value: { ok: true, n: 7 } });
  });

  it('strips markdown fences — haiku emits these despite instructions', () => {
    expect(parseModelJson('```json\n{"ok":true,"n":7}\n```', S).ok).toBe(true);
  });

  it('strips bare fences with no language tag', () => {
    expect(parseModelJson('```\n{"ok":true,"n":7}\n```', S).ok).toBe(true);
  });

  it('recovers JSON embedded in prose', () => {
    expect(parseModelJson('Sure:\n{"ok":true,"n":7}\nHope that helps!', S).ok).toBe(true);
  });

  it('handles a JSON array payload', () => {
    const A = z.array(z.object({ s: z.string() }));
    expect(parseModelJson('[{"s":"a"},{"s":"b"}]', A).ok).toBe(true);
  });

  it('reports a schema error when the JSON is valid but the shape is wrong', () => {
    const r = parseModelJson('{"ok":"yes","n":7}', S);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('schema');
      expect(r.error).toMatch(/ok/);
    }
  });

  it('fails cleanly when there is no JSON at all', () => {
    const r = parseModelJson('I cannot help with that.', S);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('extract');
  });

  it('never throws on junk input', () => {
    for (const junk of ['', '{', '}{', '```', 'null', '[[[']) {
      expect(() => parseModelJson(junk, S)).not.toThrow();
    }
  });
});
````

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/claude/src/parse`
Expected: FAIL — `Cannot find module './parse.js'`

- [ ] **Step 3: Implement**

```typescript
// packages/claude/src/parse.ts
import type { ZodType } from 'zod';

export type ParseStage = 'direct' | 'fence' | 'extract' | 'schema';
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; stage: ParseStage };

/**
 * The CLI has no structured-output mode, and models wrap JSON in fences even
 * when told not to (verified: haiku did exactly that on this machine). Three
 * extraction attempts, then schema validation. Returns a result rather than
 * throwing, so a caller records a dataGap instead of crashing an agent tick.
 */
export function parseModelJson<T>(raw: string, schema: ZodType<T>): ParseResult<T> {
  const candidates: string[] = [raw.trim()];

  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());

  const starts = [raw.indexOf('{'), raw.indexOf('[')].filter((i) => i >= 0);
  if (starts.length > 0) {
    const start = Math.min(...starts);
    const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
    if (end > start) candidates.push(raw.slice(start, end + 1));
  }

  let lastSchemaError: string | null = null;

  for (const text of candidates) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }

    const result = schema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data };
    lastSchemaError = result.error.issues
      .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
      .join('; ');
  }

  if (lastSchemaError !== null) return { ok: false, error: lastSchemaError, stage: 'schema' };
  return {
    ok: false,
    stage: 'extract',
    error: `no parseable JSON in ${raw.length} chars: ${raw.slice(0, 120)}`,
  };
}
```

Append to `packages/claude/src/index.ts`:

```typescript
export { parseModelJson } from './parse.js';
export type { ParseResult, ParseStage } from './parse.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/claude`
Expected: PASS, 17 tests

- [ ] **Step 5: Commit**

```bash
git add packages/claude
git commit -m "feat(claude): three-stage tolerant JSON parser with Zod validation"
```

---

### Task 7: Budget ledger and tier governor

**Files:**
- Create: `packages/budget/package.json`, `packages/budget/src/index.ts`, `packages/budget/src/governor.ts`
- Test: `packages/budget/src/governor.test.ts`

**Interfaces:**
- Consumes: `Db` from Task 3
- Produces: `class BudgetGovernor(db, budgetUsd, cycleStart)` with `record(call: LlmCallRecord): void`, `spent(): string`, `remaining(): string`, `fraction(): number`, `tier(): Tier`, `allows(kind: CallKind): boolean`. `Tier = 'NORMAL'|'CONSERVE'|'ESSENTIAL'|'RULES_ONLY'`, `CallKind = 'discretionary'|'entry'|'position_protecting'`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/budget/src/governor.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@aegis/db';
import { BudgetGovernor } from './governor.js';

let g: BudgetGovernor;
beforeEach(() => { g = new BudgetGovernor(openDb(':memory:'), 100, '2026-09-01'); });

function burn(usd: number) {
  g.record({ agent: 't', model: 'sonnet', tokensIn: 1, tokensOut: 1,
             costUsd: usd.toFixed(6), latencyMs: 1, ok: true });
}

describe('BudgetGovernor', () => {
  it('starts NORMAL with nothing spent', () => {
    expect(g.tier()).toBe('NORMAL');
    expect(Number(g.spent())).toBe(0);
    expect(Number(g.remaining())).toBe(100);
  });

  it('accumulates spend across calls', () => {
    burn(1.5); burn(2.25);
    expect(Number(g.spent())).toBeCloseTo(3.75, 6);
  });

  it('crosses into CONSERVE at 70%', () => {
    burn(69.9); expect(g.tier()).toBe('NORMAL');
    burn(0.2);  expect(g.tier()).toBe('CONSERVE');
  });

  it('crosses into ESSENTIAL at 85% and RULES_ONLY at 95%', () => {
    burn(86); expect(g.tier()).toBe('ESSENTIAL');
    burn(10); expect(g.tier()).toBe('RULES_ONLY');
  });

  it('blocks discretionary calls in CONSERVE but still allows entries', () => {
    burn(75);
    expect(g.allows('discretionary')).toBe(false);
    expect(g.allows('entry')).toBe(true);
    expect(g.allows('position_protecting')).toBe(true);
  });

  it('blocks new entries in ESSENTIAL but still protects open positions', () => {
    burn(90);
    expect(g.allows('entry')).toBe(false);
    expect(g.allows('position_protecting')).toBe(true);
  });

  it('blocks every LLM call in RULES_ONLY — deterministic exits must still work', () => {
    burn(99);
    for (const k of ['discretionary', 'entry', 'position_protecting'] as const) {
      expect(g.allows(k)).toBe(false);
    }
  });

  it('records failed calls too — a timeout still consumed budget', () => {
    g.record({ agent: 't', model: 'sonnet', tokensIn: 5000, tokensOut: 0,
               costUsd: '0.015000', latencyMs: 180000, ok: false, error: 'TIMEOUT' });
    expect(Number(g.spent())).toBeCloseTo(0.015, 6);
  });

  it('survives a restart by reloading the cycle row', () => {
    const db = openDb(':memory:');
    const a = new BudgetGovernor(db, 100, '2026-09-01');
    a.record({ agent: 't', model: 'haiku', tokensIn: 1, tokensOut: 1,
               costUsd: '5.000000', latencyMs: 1, ok: true });
    const b = new BudgetGovernor(db, 100, '2026-09-01');
    expect(Number(b.spent())).toBeCloseTo(5, 6);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/budget`
Expected: FAIL — `Cannot find module './governor.js'`

- [ ] **Step 3: Implement**

```typescript
// packages/budget/src/governor.ts
import Decimal from 'decimal.js';
import type { Db } from '@aegis/db';

export type Tier = 'NORMAL' | 'CONSERVE' | 'ESSENTIAL' | 'RULES_ONLY';
export type CallKind = 'discretionary' | 'entry' | 'position_protecting';

export interface LlmCallRecord {
  agent: string; model: string; tokensIn: number; tokensOut: number;
  costUsd: string; latencyMs: number; ok: boolean; error?: string; promptHash?: string;
}

const THRESHOLDS: readonly (readonly [number, Tier])[] = [
  [0.95, 'RULES_ONLY'],
  [0.85, 'ESSENTIAL'],
  [0.70, 'CONSERVE'],
];

/**
 * Which call kinds each tier still permits. The invariant that matters:
 * RULES_ONLY permits nothing, and the system must remain able to exit and
 * protect positions with zero LLM involvement. Running out of credit must never
 * leave an open position unmanaged.
 */
const ALLOWED: Record<Tier, ReadonlySet<CallKind>> = {
  NORMAL:     new Set(['discretionary', 'entry', 'position_protecting']),
  CONSERVE:   new Set(['entry', 'position_protecting']),
  ESSENTIAL:  new Set(['position_protecting']),
  RULES_ONLY: new Set(),
};

export class BudgetGovernor {
  constructor(
    private readonly db: Db,
    private readonly budgetUsd: number,
    private readonly cycleStart: string,
  ) {
    this.db.prepare('INSERT OR IGNORE INTO budget_cycles (cycle_start, budget_usd) VALUES (?, ?)')
      .run(cycleStart, String(budgetUsd));
  }

  record(call: LlmCallRecord): void {
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO llm_calls (agent, model, tokens_in, tokens_out, cost_usd, latency_ms, ok, error, prompt_hash)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(call.agent, call.model, call.tokensIn, call.tokensOut, call.costUsd,
            call.latencyMs, call.ok ? 1 : 0, call.error ?? null, call.promptHash ?? null);

      const next = new Decimal(this.spent()).plus(call.costUsd).toFixed(6);
      this.db.prepare(
        `UPDATE budget_cycles SET spent_usd = ?, tier = ?, updated_at = datetime('now')
         WHERE cycle_start = ?`,
      ).run(next, this.tierFor(next), this.cycleStart);
    })();
  }

  spent(): string {
    const row = this.db.prepare('SELECT spent_usd FROM budget_cycles WHERE cycle_start = ?')
      .get(this.cycleStart) as { spent_usd: string } | undefined;
    return row?.spent_usd ?? '0';
  }

  remaining(): string {
    return Decimal.max(0, new Decimal(this.budgetUsd).minus(this.spent())).toFixed(6);
  }

  fraction(): number {
    return new Decimal(this.spent()).div(this.budgetUsd).toNumber();
  }

  private tierFor(spent: string): Tier {
    const f = new Decimal(spent).div(this.budgetUsd).toNumber();
    for (const [threshold, tier] of THRESHOLDS) if (f >= threshold) return tier;
    return 'NORMAL';
  }

  tier(): Tier { return this.tierFor(this.spent()); }

  allows(kind: CallKind): boolean { return ALLOWED[this.tier()].has(kind); }
}
```

```typescript
// packages/budget/src/index.ts
export { BudgetGovernor } from './governor.js';
export type { Tier, CallKind, LlmCallRecord } from './governor.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/budget`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add packages/budget
git commit -m "feat(budget): spend ledger and four-tier governor that degrades to rules-only"
```

---

### Task 8: Terminal logger

**Files:**
- Create: `packages/logger/package.json`, `packages/logger/src/index.ts`, `packages/logger/src/terminal.ts`
- Test: `packages/logger/src/terminal.test.ts`

**Interfaces:**
- Consumes: `picocolors`
- Produces: `createLogger(opts): Logger` with `event/ok/warn/error/llm/budget/raw`, plus the pure formatters `formatLine`, `formatLlm`, `formatBudget` and `type Kind = 'event'|'ok'|'warn'|'error'|'llm'`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/logger/src/terminal.test.ts
import { describe, it, expect } from 'vitest';
import { formatLine, formatLlm, formatBudget } from './terminal.js';

const at = new Date('2026-09-03T14:32:07Z');
const ESC = String.fromCharCode(27);

describe('formatLine', () => {
  it('renders time, agent, glyph and message', () => {
    const s = formatLine({ at, agent: 'edgar-poller', kind: 'event',
                           msg: '8-K detected  NVDA', colour: false });
    expect(s).toContain('edgar-poller');
    expect(s).toContain('▸');
    expect(s).toContain('8-K detected  NVDA');
    expect(s.startsWith('14:32:07')).toBe(true);
  });

  it('pads agent names to a fixed column so the log stays scannable', () => {
    const a = formatLine({ at, agent: 'risk-officer', kind: 'ok', msg: 'x', colour: false });
    const b = formatLine({ at, agent: 'execution', kind: 'ok', msg: 'x', colour: false });
    expect(a.indexOf('✓')).toBe(b.indexOf('✓'));
  });

  it('uses a distinct glyph for every kind', () => {
    const glyphs = (['event', 'ok', 'warn', 'error', 'llm'] as const)
      .map((k) => formatLine({ at, agent: 'a', kind: k, msg: 'm', colour: false }));
    const marks = glyphs.map((g) => g.trim().split(/\s+/).at(-2));
    expect(new Set(marks).size).toBe(5);
  });

  it('emits no ANSI escapes when colour is off', () => {
    const s = formatLine({ at, agent: 'a', kind: 'error', msg: 'boom', colour: false });
    expect(s.includes(ESC)).toBe(false);
  });
});

describe('formatLlm', () => {
  it('shows model, token counts, cost and latency', () => {
    const s = formatLlm({ at, agent: 'earnings-reader', model: 'sonnet',
      tokensIn: 18412, tokensOut: 1203, costUsd: '0.086000', latencyMs: 11400, colour: false });
    expect(s).toContain('sonnet');
    expect(s).toContain('18,412');
    expect(s).toContain('1,203');
    expect(s).toContain('$0.086');
    expect(s).toContain('11.4s');
  });
});

describe('formatBudget', () => {
  it('shows spend, cap, percentage and days elapsed', () => {
    const s = formatBudget({ spent: '19.40', budget: 100, dayOfCycle: 11, colour: false });
    expect(s).toContain('$19.40');
    expect(s).toContain('$100');
    expect(s).toContain('19%');
    expect(s).toContain('11 days');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/logger`
Expected: FAIL — `Cannot find module './terminal.js'`

- [ ] **Step 3: Implement**

```typescript
// packages/logger/src/terminal.ts
import pc from 'picocolors';

export type Kind = 'event' | 'ok' | 'warn' | 'error' | 'llm';

const GLYPH: Record<Kind, string> = { event: '▸', ok: '✓', warn: '⚠', error: '✗', llm: '◆' };
const PAINT: Record<Kind, (s: string) => string> = {
  event: pc.cyan, ok: pc.green, warn: pc.yellow, error: pc.red, llm: pc.magenta,
};
const AGENT_COL = 16;

const hhmmss = (d: Date): string => d.toISOString().slice(11, 19);
const num = (n: number): string => n.toLocaleString('en-US');

export function formatLine(o: {
  at: Date; agent: string; kind: Kind; msg: string; colour?: boolean;
}): string {
  const agent = o.agent.padEnd(AGENT_COL).slice(0, AGENT_COL);
  const body = `${GLYPH[o.kind]} ${o.msg}`;
  if (o.colour === false) return `${hhmmss(o.at)}  ${agent}${body}`;
  return `${pc.dim(hhmmss(o.at))}  ${pc.bold(agent)}${PAINT[o.kind](body)}`;
}

export function formatLlm(o: {
  at: Date; agent: string; model: string; tokensIn: number; tokensOut: number;
  costUsd: string; latencyMs: number; colour?: boolean;
}): string {
  const msg = `${o.model}  in ${num(o.tokensIn)}  out ${num(o.tokensOut)}  `
    + `$${Number(o.costUsd).toFixed(3)}  ${(o.latencyMs / 1000).toFixed(1)}s`;
  return formatLine({ at: o.at, agent: o.agent, kind: 'llm', msg, colour: o.colour });
}

export function formatBudget(o: {
  spent: string; budget: number; dayOfCycle: number; colour?: boolean;
}): string {
  const pct = Math.round((Number(o.spent) / o.budget) * 100);
  const line = `── budget: $${Number(o.spent).toFixed(2)} / $${o.budget} this cycle `
    + `(${pct}%) · ${o.dayOfCycle} days elapsed`;
  if (o.colour === false) return `          ${line}`;
  const paint = pct >= 85 ? pc.red : pct >= 70 ? pc.yellow : pc.dim;
  return `          ${paint(line)}`;
}
```

```typescript
// packages/logger/src/index.ts
import { formatLine, formatLlm, formatBudget, type Kind } from './terminal.js';

export interface Logger {
  event(agent: string, msg: string): void;
  ok(agent: string, msg: string): void;
  warn(agent: string, msg: string): void;
  error(agent: string, msg: string): void;
  llm(agent: string, c: {
    model: string; tokensIn: number; tokensOut: number; costUsd: string; latencyMs: number;
  }): void;
  budget(spent: string, budget: number, dayOfCycle: number): void;
  raw(text: string): void;
}

export function createLogger(opts: {
  verbose?: boolean; agentFilter?: string; colour?: boolean; sink?: (line: string) => void;
} = {}): Logger {
  const out = opts.sink ?? ((l: string) => { process.stdout.write(l + '\n'); });
  const pass = (agent: string): boolean => !opts.agentFilter || agent === opts.agentFilter;
  const line = (agent: string, kind: Kind, msg: string): void => {
    if (pass(agent)) out(formatLine({ at: new Date(), agent, kind, msg, colour: opts.colour }));
  };
  return {
    event: (a, m) => line(a, 'event', m),
    ok:    (a, m) => line(a, 'ok', m),
    warn:  (a, m) => line(a, 'warn', m),
    error: (a, m) => line(a, 'error', m),
    llm: (a, c) => {
      if (pass(a)) out(formatLlm({ at: new Date(), agent: a, ...c, colour: opts.colour }));
    },
    budget: (spent, budget, dayOfCycle) =>
      out(formatBudget({ spent, budget, dayOfCycle, colour: opts.colour })),
    raw: (t) => { if (opts.verbose) out(t); },
  };
}

export { formatLine, formatLlm, formatBudget } from './terminal.js';
export type { Kind } from './terminal.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/logger`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add packages/logger
git commit -m "feat(logger): colour-coded terminal renderer with LLM cost lines"
```

---

### Task 9: Signal bus

**Files:**
- Create: `packages/agents/package.json`, `packages/agents/src/index.ts`, `packages/agents/src/bus.ts`
- Test: `packages/agents/src/bus.test.ts`

**Interfaces:**
- Consumes: `Db` from Task 3
- Produces: `class SignalBus(db)` with `emit(s: EmitInput): number`, `read(signalTypes: string[], limit?): Signal[]`, `consume(ids: number[], by: string): void`, `byId(id): Signal | null`, `pending(limit?): Signal[]`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/agents/src/bus.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@aegis/db';
import { SignalBus } from './bus.js';

let bus: SignalBus;
beforeEach(() => { bus = new SignalBus(openDb(':memory:')); });

describe('SignalBus', () => {
  it('emits and reads back an unconsumed signal', () => {
    bus.emit({ agent: 'edgar-poller', signalType: 'filing_8k', symbol: 'NVDA', data: { acc: '123' } });
    const got = bus.read(['filing_8k']);
    expect(got).toHaveLength(1);
    expect(got[0]!.symbol).toBe('NVDA');
    expect(got[0]!.data).toEqual({ acc: '123' });
  });

  it('filters by signal type', () => {
    bus.emit({ agent: 'a', signalType: 'filing_8k', symbol: 'X' });
    bus.emit({ agent: 'b', signalType: 'bearish_news', symbol: 'Y' });
    expect(bus.read(['filing_8k'])).toHaveLength(1);
    expect(bus.read(['filing_8k', 'bearish_news'])).toHaveLength(2);
  });

  it('does not return consumed signals — the core guarantee', () => {
    const id = bus.emit({ agent: 'a', signalType: 'filing_8k', symbol: 'X' });
    bus.consume([id], 'earnings-reader');
    expect(bus.read(['filing_8k'])).toHaveLength(0);
  });

  it('records who consumed it and when', () => {
    const id = bus.emit({ agent: 'a', signalType: 'filing_8k', symbol: 'X' });
    bus.consume([id], 'earnings-reader');
    const row = bus.byId(id)!;
    expect(row.consumedBy).toBe('earnings-reader');
    expect(row.consumedAt).not.toBeNull();
  });

  it('consume([]) is a no-op rather than a malformed query', () => {
    expect(() => bus.consume([], 'x')).not.toThrow();
  });

  it('read([]) returns empty rather than a malformed query', () => {
    expect(bus.read([])).toEqual([]);
  });

  it('returns newest first', () => {
    bus.emit({ agent: 'a', signalType: 't', symbol: 'FIRST' });
    bus.emit({ agent: 'a', signalType: 't', symbol: 'SECOND' });
    expect(bus.read(['t'])[0]!.symbol).toBe('SECOND');
  });

  it('round-trips a JSON payload without loss', () => {
    const data = { nested: { a: [1, 2, 3] }, s: 'x', n: 1.5, b: true, nil: null };
    const id = bus.emit({ agent: 'a', signalType: 't', data });
    expect(bus.byId(id)!.data).toEqual(data);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/agents`
Expected: FAIL — `Cannot find module './bus.js'`

- [ ] **Step 3: Implement**

```typescript
// packages/agents/src/bus.ts
import type { Db } from '@aegis/db';

export interface Signal {
  id: number; agent: string; signalType: string;
  symbol: string | null; confidence: number | null;
  data: Record<string, unknown>;
  consumed: boolean; consumedBy: string | null; consumedAt: string | null;
  createdAt: string;
}

export interface EmitInput {
  agent: string; signalType: string;
  symbol?: string; confidence?: number; data?: Record<string, unknown>;
}

interface Row {
  id: number; agent: string; signal_type: string; symbol: string | null;
  confidence: number | null; data: string; consumed: number;
  consumed_by: string | null; consumed_at: string | null; created_at: string;
}

function hydrate(r: Row): Signal {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(r.data) as Record<string, unknown>; } catch { /* keep {} */ }
  return {
    id: r.id, agent: r.agent, signalType: r.signal_type, symbol: r.symbol,
    confidence: r.confidence, data, consumed: r.consumed === 1,
    consumedBy: r.consumed_by, consumedAt: r.consumed_at, createdAt: r.created_at,
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
    const info = this.db.prepare(
      'INSERT INTO agent_signals (agent, signal_type, symbol, confidence, data) VALUES (?,?,?,?,?)',
    ).run(s.agent, s.signalType, s.symbol ?? null, s.confidence ?? null, JSON.stringify(s.data ?? {}));
    return Number(info.lastInsertRowid);
  }

  read(signalTypes: string[], limit = 100): Signal[] {
    if (signalTypes.length === 0) return [];
    const ph = signalTypes.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM agent_signals WHERE consumed = 0 AND signal_type IN (${ph})
       ORDER BY id DESC LIMIT ?`,
    ).all(...signalTypes, limit) as Row[];
    return rows.map(hydrate);
  }

  consume(ids: number[], by: string): void {
    if (ids.length === 0) return;   // an empty IN () is a syntax error
    const ph = ids.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE agent_signals SET consumed = 1, consumed_by = ?, consumed_at = datetime('now')
       WHERE id IN (${ph})`,
    ).run(by, ...ids);
  }

  byId(id: number): Signal | null {
    const r = this.db.prepare('SELECT * FROM agent_signals WHERE id = ?').get(id) as Row | undefined;
    return r ? hydrate(r) : null;
  }

  pending(limit = 200): Signal[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_signals WHERE consumed = 0 ORDER BY id DESC LIMIT ?',
    ).all(limit) as Row[];
    return rows.map(hydrate);
  }
}
```

```typescript
// packages/agents/src/index.ts
export { SignalBus } from './bus.js';
export type { Signal, EmitInput } from './bus.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/agents`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add packages/agents
git commit -m "feat(agents): durable SQLite signal bus with consume tracking"
```

---

### Task 10: BaseAgent with sleep-gap detection

**Files:**
- Create: `packages/agents/src/base.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/base.test.ts`

**Interfaces:**
- Consumes: `SignalBus` (Task 9), `Logger` (Task 8), `BudgetGovernor` (Task 7), `Db` (Task 3)
- Produces: `abstract class BaseAgent(name, opts: { intervalMs }, deps: AgentDeps)` with `shouldRun(): boolean`, `abstract execute(): Promise<void>`, `tick()`, `start()`, `stop()`, `enable()`, `disable()`, `stats(): AgentStats`, protected `onWake()` and `writeLog()`. `AgentDeps = { db; bus; log; budget; now?: () => number }`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/agents/src/base.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus } from './bus.js';
import { BaseAgent, type AgentDeps } from './base.js';

function deps(now?: () => number): AgentDeps {
  const db = openDb(':memory:');
  return {
    db,
    bus: new SignalBus(db),
    log: createLogger({ colour: false, sink: () => {} }),
    budget: new BudgetGovernor(db, 100, '2026-09-01'),
    ...(now ? { now } : {}),
  };
}

class Spy extends BaseAgent {
  runs = 0;
  throwNext = false;
  gate = true;
  constructor(d: AgentDeps) { super('spy', { intervalMs: 1000 }, d); }
  override shouldRun(): boolean { return this.gate; }
  async execute(): Promise<void> {
    if (this.throwNext) { this.throwNext = false; throw new Error('boom'); }
    this.runs++;
  }
}

describe('BaseAgent', () => {
  let a: Spy;
  beforeEach(() => { a = new Spy(deps()); });

  it('runs execute on tick when the gate is open', async () => {
    await a.tick();
    expect(a.runs).toBe(1);
  });

  it('skips when shouldRun is false and counts the skip', async () => {
    a.gate = false;
    await a.tick();
    expect(a.runs).toBe(0);
    expect(a.stats().skipped).toBe(1);
  });

  it('never lets an execute() throw escape the tick', async () => {
    a.throwNext = true;
    await expect(a.tick()).resolves.toBeUndefined();
    expect(a.stats().errors).toBe(1);
  });

  it('does not run concurrently with itself', async () => {
    let inside = 0;
    let maxInside = 0;
    class Slow extends BaseAgent {
      constructor(d: AgentDeps) { super('slow', { intervalMs: 10 }, d); }
      async execute(): Promise<void> {
        inside++; maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 20));
        inside--;
      }
    }
    const s = new Slow(deps());
    await Promise.all([s.tick(), s.tick(), s.tick()]);
    expect(maxInside).toBe(1);
  });

  it('detects a sleep gap and logs a wake recovery', async () => {
    let t = 1_000_000;
    const d = deps(() => t);
    const s = new Spy(d);
    await s.tick();
    t += 60 * 60 * 1000;                     // laptop lid closed for an hour
    await s.tick();
    const rows = d.db.prepare("SELECT * FROM agent_logs WHERE action = 'wake_recovery'").all();
    expect(rows).toHaveLength(1);
  });

  it('does not log a wake recovery for a normal interval', async () => {
    let t = 1_000_000;
    const d = deps(() => t);
    const s = new Spy(d);
    await s.tick();
    t += 1100;
    await s.tick();
    const rows = d.db.prepare("SELECT * FROM agent_logs WHERE action = 'wake_recovery'").all();
    expect(rows).toHaveLength(0);
  });

  it('respects disable()', async () => {
    a.disable();
    await a.tick();
    expect(a.runs).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/agents/src/base`
Expected: FAIL — `Cannot find module './base.js'`

- [ ] **Step 3: Implement**

```typescript
// packages/agents/src/base.ts
import type { Db } from '@aegis/db';
import type { Logger } from '@aegis/logger';
import type { BudgetGovernor } from '@aegis/budget';
import type { SignalBus } from './bus.js';

export interface AgentDeps {
  db: Db; bus: SignalBus; log: Logger; budget: BudgetGovernor;
  /** Injectable clock — the sleep-gap test cannot wait an hour. */
  now?: () => number;
}

export interface AgentStats {
  name: string; enabled: boolean; running: boolean;
  runs: number; skipped: number; errors: number; lastRun: number;
}

export abstract class BaseAgent {
  protected readonly db: Db;
  protected readonly bus: SignalBus;
  protected readonly log: Logger;
  protected readonly budget: BudgetGovernor;
  private readonly now: () => number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private enabled = true;
  private lastTickAt = 0;
  private s = { runs: 0, skipped: 0, errors: 0, lastRun: 0 };

  constructor(
    readonly name: string,
    protected readonly opts: { intervalMs: number },
    deps: AgentDeps,
  ) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.log = deps.log;
    this.budget = deps.budget;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** Override to gate execution — market hours, open positions, budget tier. */
  shouldRun(): boolean { return true; }

  abstract execute(): Promise<void>;

  async tick(): Promise<void> {
    if (this.running || !this.enabled) return;   // never overlap with itself
    this.running = true;
    try {
      const now = this.now();
      // A laptop lid closing mid-session is a real failure mode: timers do not
      // fire while suspended, and the first tick after wake carries stale
      // state. Detect the gap explicitly rather than acting on stale data.
      if (this.lastTickAt > 0 && now - this.lastTickAt > this.opts.intervalMs * 2.5) {
        const mins = Math.round((now - this.lastTickAt) / 60_000);
        this.log.warn(this.name, `resumed after a ${mins}m gap (system sleep?)`);
        this.writeLog('wake_recovery', null, `gap ${mins}m`);
        await this.onWake();
      }
      this.lastTickAt = now;

      if (!this.shouldRun()) { this.s.skipped++; return; }

      await this.execute();
      this.s.runs++;
      this.s.lastRun = now;
    } catch (err) {
      this.s.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(this.name, msg);
      this.writeLog('error', null, msg);
    } finally {
      this.running = false;
    }
  }

  /** Override to drop caches after a suspend. */
  protected async onWake(): Promise<void> { /* default: nothing */ }

  start(): void {
    this.log.ok(this.name, `started · every ${Math.round(this.opts.intervalMs / 1000)}s`);
    this.writeLog('started', null, `interval=${this.opts.intervalMs}ms`);
    this.lastTickAt = this.now();
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.log.event(this.name, 'stopped');
  }

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }

  stats(): AgentStats {
    return { name: this.name, enabled: this.enabled, running: this.running, ...this.s };
  }

  protected writeLog(action: string, symbol: string | null, details: string | null): void {
    try {
      this.db.prepare('INSERT INTO agent_logs (agent, action, symbol, details) VALUES (?,?,?,?)')
        .run(this.name, action, symbol, details);
    } catch { /* logging must never crash an agent */ }
  }
}
```

Append to `packages/agents/src/index.ts`:

```typescript
export { BaseAgent } from './base.js';
export type { AgentDeps, AgentStats } from './base.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/agents`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add packages/agents
git commit -m "feat(agents): BaseAgent ticker with overlap guard and sleep-gap detection"
```

---

### Task 11: Orchestrator and the daemon entry point

**Files:**
- Create: `packages/agents/src/orchestrator.ts`, `apps/daemon/package.json`, `apps/daemon/src/main.ts`, `.env.example`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: `BaseAgent`, `Logger`
- Produces: `class Orchestrator(log)` with `register(agent: BaseAgent, delayMs?: number): void`, `start(): void`, `stop(): void`, `status(): AgentStats[]`. Daemon runs via `pnpm dev`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/agents/src/orchestrator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus } from './bus.js';
import { BaseAgent, type AgentDeps } from './base.js';
import { Orchestrator } from './orchestrator.js';

function deps(): AgentDeps {
  const db = openDb(':memory:');
  return {
    db, bus: new SignalBus(db),
    log: createLogger({ colour: false, sink: () => {} }),
    budget: new BudgetGovernor(db, 100, '2026-09-01'),
  };
}
class Noop extends BaseAgent {
  constructor(n: string, d: AgentDeps) { super(n, { intervalMs: 60_000 }, d); }
  async execute(): Promise<void> { /* nothing */ }
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Orchestrator', () => {
  it('staggers starts so agents do not all fire at once', () => {
    const d = deps();
    const o = new Orchestrator(d.log);
    const a = new Noop('a', d);
    const b = new Noop('b', d);
    const sa = vi.spyOn(a, 'start');
    const sb = vi.spyOn(b, 'start');
    o.register(a, 0);
    o.register(b, 5000);
    o.start();
    expect(sa).toHaveBeenCalled();
    expect(sb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(sb).toHaveBeenCalled();
    o.stop();
  });

  it('stops every registered agent', () => {
    const d = deps();
    const o = new Orchestrator(d.log);
    const a = new Noop('a', d);
    const stop = vi.spyOn(a, 'stop');
    o.register(a, 0);
    o.start();
    o.stop();
    expect(stop).toHaveBeenCalled();
  });

  it('cancels pending staggered starts on stop', () => {
    const d = deps();
    const o = new Orchestrator(d.log);
    const b = new Noop('b', d);
    const sb = vi.spyOn(b, 'start');
    o.register(b, 5000);
    o.start();
    o.stop();
    vi.advanceTimersByTime(10_000);
    expect(sb).not.toHaveBeenCalled();
  });

  it('reports status for all agents', () => {
    const d = deps();
    const o = new Orchestrator(d.log);
    o.register(new Noop('a', d), 0);
    o.register(new Noop('b', d), 0);
    expect(o.status().map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('is idempotent — a second start does not double-register', () => {
    const d = deps();
    const o = new Orchestrator(d.log);
    const a = new Noop('a', d);
    const s = vi.spyOn(a, 'start');
    o.register(a, 0);
    o.start();
    o.start();
    expect(s).toHaveBeenCalledTimes(1);
    o.stop();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/agents/src/orchestrator`
Expected: FAIL — `Cannot find module './orchestrator.js'`

- [ ] **Step 3: Implement the orchestrator**

```typescript
// packages/agents/src/orchestrator.ts
import type { Logger } from '@aegis/logger';
import type { BaseAgent, AgentStats } from './base.js';

export class Orchestrator {
  private readonly entries: { agent: BaseAgent; delayMs: number }[] = [];
  private timers: NodeJS.Timeout[] = [];
  private started = false;

  constructor(private readonly log: Logger) {}

  register(agent: BaseAgent, delayMs = 0): void {
    this.entries.push({ agent, delayMs });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.log.ok('orchestrator', `starting ${this.entries.length} agents`);
    for (const { agent, delayMs } of this.entries) {
      // Staggered so a cold start does not fire every agent — and every data
      // fetch — in the same millisecond.
      if (delayMs === 0) agent.start();
      else this.timers.push(setTimeout(() => agent.start(), delayMs));
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const { agent } of this.entries) agent.stop();
    this.log.event('orchestrator', 'all agents stopped');
  }

  status(): AgentStats[] {
    return this.entries.map((e) => e.agent.stats());
  }
}
```

Append to `packages/agents/src/index.ts`:

```typescript
export { Orchestrator } from './orchestrator.js';
```

- [ ] **Step 4: Write the daemon entry point**

```typescript
// apps/daemon/src/main.ts
import { loadConfig } from '@aegis/config';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus, Orchestrator, type AgentDeps } from '@aegis/agents';
import { setConcurrency } from '@aegis/claude';

const cfg = loadConfig(process.env);

const filterIdx = process.argv.indexOf('--agent');
const agentFilter = filterIdx >= 0 ? process.argv[filterIdx + 1] : undefined;

const log = createLogger({
  verbose: cfg.verbose || process.argv.includes('--verbose'),
  ...(agentFilter ? { agentFilter } : {}),
});

const db = openDb(cfg.dbPath);
const bus = new SignalBus(db);
// Credit cycles are monthly; the first of the current month is the cycle key.
const cycleStart = `${new Date().toISOString().slice(0, 7)}-01`;
const budget = new BudgetGovernor(db, cfg.monthlyBudgetUsd, cycleStart);
setConcurrency(cfg.claudeConcurrency);

const deps: AgentDeps = { db, bus, log, budget };
void deps;   // agents are registered here from Phase 3 onward

const orchestrator = new Orchestrator(log);

// The daemon is intentionally runnable with zero agents. A skeleton that boots,
// reports and shuts down cleanly is the thing to prove before anything trades.

log.ok('daemon', `aegis up · mode=${cfg.tradingMode} · db=${cfg.dbPath}`);
log.event('daemon', `budget tier ${budget.tier()} · claude concurrency ${cfg.claudeConcurrency}`);
orchestrator.start();
log.budget(budget.spent(), cfg.monthlyBudgetUsd, new Date().getUTCDate());

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1);   // a second Ctrl-C forces
    shuttingDown = true;
    log.warn('daemon', `${sig} received — stopping agents`);
    orchestrator.stop();
    db.close();
    log.ok('daemon', 'clean shutdown');
    process.exit(0);
  });
}
```

```bash
# .env.example
TRADING_MODE=paper
DB_PATH=./data/aegis.db
LOG_LEVEL=info
VERBOSE=false
MONTHLY_BUDGET_USD=100
AUDIT_FLOOR=70
CLAUDE_CONCURRENCY=3
SUE_THRESHOLD=1.5
DASHBOARD_PORT=3777
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm vitest run`
Expected: PASS across all six packages, 69 tests

- [ ] **Step 6: Boot the daemon**

```bash
cp .env.example .env
pnpm dev
```

Expected, in order: `aegis up · mode=paper`, a budget tier line, `starting 0 agents`, and a budget footer reading `$0.00 / $100`. Then `Ctrl-C` prints `SIGINT received` and `clean shutdown`, exiting 0.

- [ ] **Step 7: Verify the invariant holds under a hostile config**

```bash
TRADING_MODE=live DB_PATH=./data/aegis.db pnpm dev
```

Expected: immediate `ConfigError: Invalid configuration for TRADING_MODE: only "paper" is permitted (INV-1); got "live"`, a non-zero exit, and **no database file created**.

- [ ] **Step 8: Commit and tag the gate**

```bash
git add packages/agents apps/daemon .env.example
git commit -m "feat(daemon): orchestrator with staggered starts and clean shutdown"
git tag phase-2-gate
```

---

## What Phase 3 picks up

With the runtime proven, Phase 3 adds the first real agents: the Alpaca paper adapter behind a `BrokerAdapter` interface, the position ledger with lot accounting, the reconciler, and the deterministic Risk Officer. No model calls in that phase either — everything that moves money is proven before the alpha engine is written. The Earnings Reader and the EDGAR poller land in Phase 4.
