# Phase 0–1: Foundation & Broker Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo with a provably-enforced paper-only invariant, then build the broker spine — one `BrokerAdapter` interface, a Binance-testnet implementation, a lot-accounting position ledger, and reconciliation — so a hand-placed order round-trips and reconciles before any agent exists.

**Architecture:** pnpm monorepo, TypeScript throughout. `packages/config` owns fail-loud env parsing and the frozen paper-endpoint allowlist. `packages/db` owns the Drizzle schema and migrations. `packages/brokers` owns the adapter interface plus a shared conformance suite every adapter must pass. `packages/ledger` owns lot-level position accounting and is the reconciliation arbiter. Nothing in these phases calls an LLM.

**Tech Stack:** TypeScript 5.6+, pnpm workspaces, Vitest, Drizzle ORM, PostgreSQL 16, Redis 7, CCXT, Zod, Pino, Docker Compose.

**Spec:** [`docs/01-REQUIREMENTS.md`](../../01-REQUIREMENTS.md) · agent context in [`docs/02-AGENT-ARCHITECTURE.md`](../../02-AGENT-ARCHITECTURE.md) · sequencing rationale in [`docs/03-ROADMAP.md`](../../03-ROADMAP.md)

## Global Constraints

- **INV-1 — paper money only.** `TRADING_MODE` accepts only the literal string `paper`. Every adapter base URL comes from a frozen `PAPER_ENDPOINTS` allowlist. Live broker hostnames must not appear anywhere in the repo or built bundle.
- **INV-4 — risk limits are deterministic code**, never an LLM. (Enforced in Phase 2; do not add LLM calls to `packages/risk` here.)
- **INV-6 — the kill switch is honoured within one tick.** (Wired in Phase 2; the ledger and router must not cache a stale HALT value.)
- **Fail-loud config.** A malformed env value raises at boot. Never silently fall back to a default.
- Node ≥ 20. TypeScript `strict: true`, `noUncheckedIndexedAccess: true`.
- All money is handled as integer minor units or `decimal.js` — **never** a raw JS `number` for a price or quantity that is persisted.
- Every package exports types only from `src/index.ts`. No deep imports across packages.
- Test framework is Vitest. Every task ends with a green test run and a commit.

---

### Task 1: Monorepo skeleton and fail-loud config

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc`
- Create: `packages/config/package.json`, `packages/config/tsconfig.json`, `packages/config/src/index.ts`, `packages/config/src/env.ts`
- Test: `packages/config/src/env.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig` — throws `ConfigError` on any malformed value. `AppConfig` has `{ tradingMode: 'paper'; databaseUrl: string; redisUrl: string; logLevel: 'debug'|'info'|'warn'|'error'; auditFloor: number; maxDebateRounds: number; maxRiskRounds: number }`.

- [ ] **Step 1: Scaffold the workspace**

```bash
mkdir -p packages/config/src
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - 'apps/*'
  - 'packages/*'
EOF
cat > .nvmrc <<'EOF'
20
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
    "test:watch": "vitest",
    "typecheck": "tsc -b",
    "lint": "eslint ."
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
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
    "esModuleInterop": true
  }
}
```

- [ ] **Step 2: Write the failing config test**

```typescript
// packages/config/src/env.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from './env.js';

const base = {
  TRADING_MODE: 'paper',
  DATABASE_URL: 'postgres://localhost:5432/aegis',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const cfg = loadConfig(base);
    expect(cfg.tradingMode).toBe('paper');
    expect(cfg.auditFloor).toBe(70); // default
  });

  it('rejects any TRADING_MODE other than paper (INV-1)', () => {
    expect(() => loadConfig({ ...base, TRADING_MODE: 'live' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TRADING_MODE: 'PAPER' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TRADING_MODE: '' })).toThrow(ConfigError);
  });

  it('fails loud on a malformed boolean rather than defaulting', () => {
    expect(() => loadConfig({ ...base, CHECKPOINT_ENABLED: 'treu' })).toThrow(/CHECKPOINT_ENABLED/);
  });

  it('fails loud on a non-numeric AUDIT_FLOOR', () => {
    expect(() => loadConfig({ ...base, AUDIT_FLOOR: 'high' })).toThrow(/AUDIT_FLOOR/);
  });

  it('rejects an AUDIT_FLOOR outside 0-100', () => {
    expect(() => loadConfig({ ...base, AUDIT_FLOOR: '150' })).toThrow(/AUDIT_FLOOR/);
  });

  it('throws when a required variable is missing', () => {
    const { DATABASE_URL: _omit, ...withoutDb } = base;
    expect(() => loadConfig(withoutDb)).toThrow(/DATABASE_URL/);
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
  databaseUrl: string;
  redisUrl: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  auditFloor: number;
  maxDebateRounds: number;
  maxRiskRounds: number;
  checkpointEnabled: boolean;
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

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
  throw new ConfigError(key, `expected a boolean (${[...TRUE, ...FALSE].join('/')}), got ${JSON.stringify(v)}`);
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const v = env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ConfigError(key, `expected an integer, got ${JSON.stringify(v)}`);
  if (n < min || n > max) throw new ConfigError(key, `expected ${min}-${max}, got ${n}`);
  return n;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // INV-1: the ONLY accepted value. Case-sensitive on purpose.
  const mode = required(env, 'TRADING_MODE');
  if (mode !== 'paper') {
    throw new ConfigError('TRADING_MODE', `only "paper" is permitted (INV-1); got ${JSON.stringify(mode)}`);
  }

  const rawLevel = env.LOG_LEVEL ?? 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(rawLevel)) {
    throw new ConfigError('LOG_LEVEL', `expected one of ${LOG_LEVELS.join('/')}, got ${JSON.stringify(rawLevel)}`);
  }

  return {
    tradingMode: 'paper',
    databaseUrl: required(env, 'DATABASE_URL'),
    redisUrl: required(env, 'REDIS_URL'),
    logLevel: rawLevel as AppConfig['logLevel'],
    auditFloor: int(env, 'AUDIT_FLOOR', 70, 0, 100),
    maxDebateRounds: int(env, 'MAX_DEBATE_ROUNDS', 2, 1, 5),
    maxRiskRounds: int(env, 'MAX_RISK_ROUNDS', 1, 1, 3),
    checkpointEnabled: bool(env, 'CHECKPOINT_ENABLED', true),
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
Expected: PASS, 6 tests

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .nvmrc packages/config
git commit -m "feat(config): fail-loud env parsing with paper-only TRADING_MODE (INV-1)"
```

---

### Task 2: Frozen paper-endpoint allowlist + bundle-grep guard

**Files:**
- Create: `packages/config/src/endpoints.ts`
- Test: `packages/config/src/endpoints.test.ts`, `packages/config/src/no-live-endpoints.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `PAPER_ENDPOINTS: Readonly<Record<VenueId, string>>`, `type VenueId = 'binance-testnet' | 'alpaca-paper' | 'india-sim'`, `resolveEndpoint(venue: VenueId): string` — throws on an unknown venue.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/config/src/endpoints.test.ts
import { describe, it, expect } from 'vitest';
import { PAPER_ENDPOINTS, resolveEndpoint } from './endpoints.js';

describe('PAPER_ENDPOINTS', () => {
  it('exposes exactly the three v1 paper venues', () => {
    expect(Object.keys(PAPER_ENDPOINTS).sort()).toEqual(
      ['alpaca-paper', 'binance-testnet', 'india-sim'],
    );
  });

  it('resolves a known venue', () => {
    expect(resolveEndpoint('alpaca-paper')).toBe('https://paper-api.alpaca.markets');
  });

  it('throws on an unknown venue rather than returning undefined', () => {
    // @ts-expect-error deliberately invalid at the type level
    expect(() => resolveEndpoint('alpaca-live')).toThrow(/unknown venue/i);
  });

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(PAPER_ENDPOINTS)).toBe(true);
  });
});
```

```typescript
// packages/config/src/no-live-endpoints.test.ts
// INV-1 guard: no live broker hostname may appear anywhere in source.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const FORBIDDEN = [
  'api.alpaca.markets',      // Alpaca LIVE trading host
  'api.binance.com',         // Binance LIVE host
  'fapi.binance.com',        // Binance LIVE futures host
  'api.kite.trade',          // Zerodha LIVE host
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'reference', 'coverage']);
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(extname(entry))) out.push(full);
  }
  return out;
}

describe('INV-1: no live broker endpoints in source', () => {
  it('finds no forbidden hostname in any scanned file', () => {
    const root = new URL('../../../', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const file of walk(root)) {
      // The guard file itself legitimately contains the strings.
      if (file.endsWith('no-live-endpoints.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const host of FORBIDDEN) {
        if (text.includes(host)) offenders.push(`${file} contains ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run packages/config/src/endpoints`
Expected: FAIL — `Cannot find module './endpoints.js'`

- [ ] **Step 3: Implement the allowlist**

```typescript
// packages/config/src/endpoints.ts
export type VenueId = 'binance-testnet' | 'alpaca-paper' | 'india-sim';
export type MarketId = 'US' | 'IN' | 'CRYPTO';

/**
 * INV-1: the complete, frozen set of endpoints this system may ever talk to.
 * Adding a live host here is a licence-to-lose-money change and must be
 * rejected in review. The companion test `no-live-endpoints.test.ts` fails the
 * build if a live hostname appears anywhere in source.
 */
export const PAPER_ENDPOINTS = Object.freeze({
  'binance-testnet': 'https://testnet.binance.vision',
  'alpaca-paper': 'https://paper-api.alpaca.markets',
  'india-sim': 'internal://india-sim',
} as const satisfies Record<VenueId, string>);

export const VENUE_MARKET = Object.freeze({
  'binance-testnet': 'CRYPTO',
  'alpaca-paper': 'US',
  'india-sim': 'IN',
} as const satisfies Record<VenueId, MarketId>);

export function resolveEndpoint(venue: VenueId): string {
  const url = PAPER_ENDPOINTS[venue];
  if (url === undefined) throw new Error(`Unknown venue: ${String(venue)}`);
  return url;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/config`
Expected: PASS, 10 tests total

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/endpoints.ts packages/config/src/endpoints.test.ts packages/config/src/no-live-endpoints.test.ts
git commit -m "feat(config): frozen paper-endpoint allowlist + live-hostname bundle guard (INV-1)"
```

---

### Task 3: Database schema and migrations

**Files:**
- Create: `docker-compose.yml`, `packages/db/package.json`, `packages/db/drizzle.config.ts`, `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/index.ts`
- Test: `packages/db/src/schema.test.ts`

**Interfaces:**
- Consumes: `AppConfig.databaseUrl` from Task 1
- Produces: Drizzle tables `orders`, `fills`, `positions`, `lots`, `reconciliations`; `getDb(url: string)` returning a typed Drizzle client. Later phases add `cycles`, `contextPackets`, `analystReports`, `debateTurns`, `decisions`, `executionPlans`, `riskEvaluations`, `watchConditions`, `notifications`, `reflections`, `evalSnapshots`.

- [ ] **Step 1: Bring up Postgres and Redis**

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: aegis
      POSTGRES_PASSWORD: aegis
      POSTGRES_DB: aegis
    ports: ['5432:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U aegis']
      interval: 5s
      retries: 10
  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
```

```bash
docker compose up -d && docker compose ps
```

- [ ] **Step 2: Write the failing schema test**

```typescript
// packages/db/src/schema.test.ts
import { describe, it, expect } from 'vitest';
import { orders, fills, positions, lots } from './schema.js';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('schema', () => {
  it('orders.decisionId is NOT NULL (INV-2: no order without lineage)', () => {
    const col = getTableConfig(orders).columns.find((c) => c.name === 'decision_id');
    expect(col).toBeDefined();
    expect(col!.notNull).toBe(true);
  });

  it('orders has a unique idempotency key on (decision_id, rung_index)', () => {
    const { uniqueConstraints } = getTableConfig(orders);
    const names = uniqueConstraints.flatMap((u) => u.columns.map((c) => c.name)).sort();
    expect(names).toEqual(['decision_id', 'rung_index']);
  });

  it('prices and quantities are numeric, never float', () => {
    for (const table of [orders, fills, lots]) {
      for (const col of getTableConfig(table).columns) {
        if (/price|qty|quantity|fee|cost/.test(col.name)) {
          expect(col.getSQLType()).toMatch(/^numeric/);
        }
      }
    }
  });

  it('lots carry an acquisition timestamp so FIFO and specific-ID are both possible', () => {
    const names = getTableConfig(lots).columns.map((c) => c.name);
    expect(names).toContain('acquired_at');
    expect(names).toContain('cost_basis');
    expect(names).toContain('remaining_qty');
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm vitest run packages/db`
Expected: FAIL — `Cannot find module './schema.js'`

- [ ] **Step 4: Implement the schema**

```typescript
// packages/db/src/schema.ts
import {
  pgTable, uuid, text, numeric, timestamp, integer, jsonb, boolean, unique, index,
} from 'drizzle-orm/pg-core';

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  // INV-2: every order resolves to the reasoning that produced it.
  decisionId: uuid('decision_id').notNull(),
  rungIndex: integer('rung_index').notNull().default(0),
  venue: text('venue').notNull(),
  venueOrderId: text('venue_order_id'),
  symbol: text('symbol').notNull(),
  side: text('side', { enum: ['buy', 'sell'] }).notNull(),
  type: text('type', { enum: ['market', 'limit', 'stop', 'stop_limit'] }).notNull(),
  qty: numeric('qty', { precision: 28, scale: 10 }).notNull(),
  limitPrice: numeric('limit_price', { precision: 28, scale: 10 }),
  stopPrice: numeric('stop_price', { precision: 28, scale: 10 }),
  status: text('status', {
    enum: ['pending', 'submitted', 'partial', 'filled', 'cancelled', 'rejected'],
  }).notNull().default('pending'),
  rejectReason: text('reject_reason'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Idempotency: a restart mid-submit must not double-place a rung.
  idempotency: unique('orders_decision_rung_uq').on(t.decisionId, t.rungIndex),
  bySymbol: index('orders_symbol_idx').on(t.venue, t.symbol),
}));

export const fills = pgTable('fills', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  venueFillId: text('venue_fill_id').notNull(),
  qty: numeric('qty', { precision: 28, scale: 10 }).notNull(),
  price: numeric('price', { precision: 28, scale: 10 }).notNull(),
  fee: numeric('fee', { precision: 28, scale: 10 }).notNull().default('0'),
  filledAt: timestamp('filled_at', { withTimezone: true }).notNull(),
}, (t) => ({
  // The same WS event can arrive twice; dedupe on the venue's own id.
  venueUq: unique('fills_venue_fill_uq').on(t.venueFillId),
}));

export const positions = pgTable('positions', {
  id: uuid('id').primaryKey().defaultRandom(),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  qty: numeric('qty', { precision: 28, scale: 10 }).notNull().default('0'),
  avgCost: numeric('avg_cost', { precision: 28, scale: 10 }).notNull().default('0'),
  realisedPnl: numeric('realised_pnl', { precision: 28, scale: 10 }).notNull().default('0'),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({
  venueSymbolUq: unique('positions_venue_symbol_uq').on(t.venue, t.symbol),
}));

export const lots = pgTable('lots', {
  id: uuid('id').primaryKey().defaultRandom(),
  positionId: uuid('position_id').notNull().references(() => positions.id),
  fillId: uuid('fill_id').notNull().references(() => fills.id),
  originalQty: numeric('original_qty', { precision: 28, scale: 10 }).notNull(),
  remainingQty: numeric('remaining_qty', { precision: 28, scale: 10 }).notNull(),
  costBasis: numeric('cost_basis', { precision: 28, scale: 10 }).notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
}, (t) => ({
  byPosition: index('lots_position_idx').on(t.positionId, t.acquiredAt),
}));

export const reconciliations = pgTable('reconciliations', {
  id: uuid('id').primaryKey().defaultRandom(),
  venue: text('venue').notNull(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  matched: boolean('matched').notNull(),
  breaks: jsonb('breaks').$type<Array<{ symbol: string; ledgerQty: string; venueQty: string }>>().notNull().default([]),
});
```

```typescript
// packages/db/src/client.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export function getDb(url: string) {
  const pool = new pg.Pool({ connectionString: url });
  return drizzle(pool, { schema });
}
export type Db = ReturnType<typeof getDb>;
```

- [ ] **Step 5: Generate and apply the migration**

```bash
pnpm --filter @aegis/db exec drizzle-kit generate
pnpm --filter @aegis/db exec drizzle-kit migrate
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/db`
Expected: PASS, 4 tests

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml packages/db
git commit -m "feat(db): orders/fills/positions/lots schema with lineage and idempotency constraints"
```

---

### Task 4: BrokerAdapter interface and conformance suite

**Files:**
- Create: `packages/brokers/package.json`, `packages/brokers/src/types.ts`, `packages/brokers/src/index.ts`
- Create: `packages/brokers/src/conformance.ts` (the shared suite every adapter must pass)
- Create: `packages/brokers/src/fake-adapter.ts` (in-memory reference implementation)
- Test: `packages/brokers/src/fake-adapter.test.ts`

**Interfaces:**
- Consumes: `VenueId`, `MarketId` from `@aegis/config`
- Produces: `interface BrokerAdapter` exactly as specified in requirements § 6.1; `runConformanceSuite(name: string, factory: () => Promise<BrokerAdapter>)` which registers a Vitest `describe` block; `FakeAdapter` for use by later phases' tests.

- [ ] **Step 1: Define the types**

```typescript
// packages/brokers/src/types.ts
import type { VenueId, MarketId } from '@aegis/config';

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type OrderStatus = 'pending' | 'submitted' | 'partial' | 'filled' | 'cancelled' | 'rejected';

export interface OrderRequest {
  clientOrderId: string;   // our idempotency key: `${decisionId}:${rungIndex}`
  symbol: string;
  side: Side;
  type: OrderType;
  qty: string;             // decimal string — never a JS number
  limitPrice?: string;
  stopPrice?: string;
}

export interface VenueOrder {
  venueOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: string;
  filledQty: string;
  avgFillPrice: string | null;
  status: OrderStatus;
  submittedAt: string;
}

export interface FillEvent {
  venueOrderId: string;
  venueFillId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: string;
  price: string;
  fee: string;
  filledAt: string;
}

export interface VenuePosition { symbol: string; qty: string; avgCost: string }
export interface Account { equity: string; cash: string; currency: string }

export interface VenueConstraints {
  tickSize: (symbol: string) => string;
  lotSize: (symbol: string) => string;
  minNotional: (symbol: string) => string;
  supportsFractional: boolean;
  supportsShort: boolean;
  supportsBracket: boolean;
}

export interface SessionCalendar {
  isOpen(at: Date): boolean;
  nextOpen(at: Date): Date;
  nextClose(at: Date): Date;
}

export interface ReconciliationReport {
  matched: boolean;
  breaks: Array<{ symbol: string; ledgerQty: string; venueQty: string }>;
}

export type Unsubscribe = () => void;

export interface BrokerAdapter {
  readonly venue: VenueId;
  readonly market: MarketId;
  /** INV-1: the type has no other member. */
  readonly mode: 'paper';

  getAccount(): Promise<Account>;
  getPositions(): Promise<VenuePosition[]>;
  submitOrder(req: OrderRequest): Promise<VenueOrder>;
  cancelOrder(venueOrderId: string): Promise<void>;
  listOpenOrders(): Promise<VenueOrder[]>;
  streamFills(onEvent: (e: FillEvent) => void): Unsubscribe;
  reconcile(ledger: VenuePosition[]): Promise<ReconciliationReport>;

  readonly calendar: SessionCalendar;
  readonly constraints: VenueConstraints;
}
```

- [ ] **Step 2: Write the conformance suite (this IS the failing test)**

```typescript
// packages/brokers/src/conformance.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { BrokerAdapter } from './types.js';

/** Every adapter must pass this identically. Adding a venue = one file + a green run. */
export function runConformanceSuite(name: string, factory: () => Promise<BrokerAdapter>) {
  describe(`BrokerAdapter conformance: ${name}`, () => {
    let a: BrokerAdapter;
    beforeEach(async () => { a = await factory(); });

    it('declares paper mode (INV-1)', () => {
      expect(a.mode).toBe('paper');
    });

    it('returns an account with a numeric-string equity', async () => {
      const acct = await a.getAccount();
      expect(acct.equity).toMatch(/^-?\d+(\.\d+)?$/);
      expect(acct.currency).toMatch(/^[A-Z]{3,4}$/);
    });

    it('submits an order and echoes back the clientOrderId', async () => {
      const o = await a.submitOrder({
        clientOrderId: 'dec-1:0', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: '0.001',
      });
      expect(o.clientOrderId).toBe('dec-1:0');
      expect(o.venueOrderId).toBeTruthy();
    });

    it('is idempotent on clientOrderId — resubmitting returns the same venue order', async () => {
      const req = {
        clientOrderId: 'dec-2:0', symbol: 'BTC/USDT', side: 'buy' as const, type: 'market' as const, qty: '0.001',
      };
      const first = await a.submitOrder(req);
      const second = await a.submitOrder(req);
      expect(second.venueOrderId).toBe(first.venueOrderId);
    });

    it('emits a fill event carrying a stable venueFillId', async () => {
      const events: string[] = [];
      const stop = a.streamFills((e) => events.push(e.venueFillId));
      await a.submitOrder({
        clientOrderId: 'dec-3:0', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: '0.001',
      });
      await new Promise((r) => setTimeout(r, 250));
      stop();
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events).size).toBe(events.length); // no duplicate ids
    });

    it('reports a reconciliation break when the ledger disagrees', async () => {
      const report = await a.reconcile([{ symbol: 'BTC/USDT', qty: '999', avgCost: '1' }]);
      expect(report.matched).toBe(false);
      expect(report.breaks.length).toBeGreaterThan(0);
    });

    it('exposes venue constraints as decimal strings', () => {
      expect(a.constraints.tickSize('BTC/USDT')).toMatch(/^\d+(\.\d+)?$/);
      expect(a.constraints.minNotional('BTC/USDT')).toMatch(/^\d+(\.\d+)?$/);
    });
  });
}
```

```typescript
// packages/brokers/src/fake-adapter.test.ts
import { runConformanceSuite } from './conformance.js';
import { FakeAdapter } from './fake-adapter.js';

runConformanceSuite('FakeAdapter', async () => new FakeAdapter());
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm vitest run packages/brokers`
Expected: FAIL — `Cannot find module './fake-adapter.js'`

- [ ] **Step 4: Implement the fake adapter**

```typescript
// packages/brokers/src/fake-adapter.ts
import { randomUUID } from 'node:crypto';
import type {
  BrokerAdapter, OrderRequest, VenueOrder, FillEvent, VenuePosition,
  Account, ReconciliationReport, Unsubscribe,
} from './types.js';

/** In-memory adapter. Fills every market order instantly at a fixed price. */
export class FakeAdapter implements BrokerAdapter {
  readonly venue = 'india-sim' as const;
  readonly market = 'IN' as const;
  readonly mode = 'paper' as const;

  private orders = new Map<string, VenueOrder>();      // clientOrderId -> order
  private positions = new Map<string, VenuePosition>();
  private listeners = new Set<(e: FillEvent) => void>();
  private readonly price = '100';

  async getAccount(): Promise<Account> {
    return { equity: '1000000', cash: '1000000', currency: 'INR' };
  }

  async getPositions(): Promise<VenuePosition[]> {
    return [...this.positions.values()];
  }

  async submitOrder(req: OrderRequest): Promise<VenueOrder> {
    const existing = this.orders.get(req.clientOrderId);
    if (existing) return existing;   // idempotent

    const order: VenueOrder = {
      venueOrderId: randomUUID(),
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      qty: req.qty,
      filledQty: req.qty,
      avgFillPrice: this.price,
      status: 'filled',
      submittedAt: new Date().toISOString(),
    };
    this.orders.set(req.clientOrderId, order);

    const prev = this.positions.get(req.symbol)?.qty ?? '0';
    const delta = req.side === 'buy' ? Number(req.qty) : -Number(req.qty);
    this.positions.set(req.symbol, {
      symbol: req.symbol,
      qty: String(Number(prev) + delta),
      avgCost: this.price,
    });

    const fill: FillEvent = {
      venueOrderId: order.venueOrderId,
      venueFillId: randomUUID(),
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      price: this.price,
      fee: '0',
      filledAt: new Date().toISOString(),
    };
    queueMicrotask(() => { for (const l of this.listeners) l(fill); });
    return order;
  }

  async cancelOrder(): Promise<void> { /* everything fills instantly */ }

  async listOpenOrders(): Promise<VenueOrder[]> { return []; }

  streamFills(onEvent: (e: FillEvent) => void): Unsubscribe {
    this.listeners.add(onEvent);
    return () => { this.listeners.delete(onEvent); };
  }

  async reconcile(ledger: VenuePosition[]): Promise<ReconciliationReport> {
    const breaks: ReconciliationReport['breaks'] = [];
    for (const l of ledger) {
      const v = this.positions.get(l.symbol);
      const venueQty = v?.qty ?? '0';
      if (Number(venueQty) !== Number(l.qty)) {
        breaks.push({ symbol: l.symbol, ledgerQty: l.qty, venueQty });
      }
    }
    return { matched: breaks.length === 0, breaks };
  }

  readonly calendar = {
    isOpen: () => true,
    nextOpen: (at: Date) => at,
    nextClose: (at: Date) => at,
  };

  readonly constraints = {
    tickSize: () => '0.05',
    lotSize: () => '1',
    minNotional: () => '100',
    supportsFractional: false,
    supportsShort: false,
    supportsBracket: false,
  };
}
```

- [ ] **Step 5: Run the conformance suite**

Run: `pnpm vitest run packages/brokers`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add packages/brokers
git commit -m "feat(brokers): BrokerAdapter interface, shared conformance suite, in-memory fake"
```

---

### Task 5: Binance testnet adapter

**Files:**
- Create: `packages/brokers/src/binance-testnet.ts`
- Test: `packages/brokers/src/binance-testnet.test.ts`

**Interfaces:**
- Consumes: `BrokerAdapter` and `runConformanceSuite` from Task 4; `resolveEndpoint('binance-testnet')` from Task 2
- Produces: `class BinanceTestnetAdapter implements BrokerAdapter` — constructor `(opts: { apiKey: string; secret: string })`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/brokers/src/binance-testnet.test.ts
import { describe, it, expect } from 'vitest';
import { BinanceTestnetAdapter } from './binance-testnet.js';
import { runConformanceSuite } from './conformance.js';

describe('BinanceTestnetAdapter construction', () => {
  it('enables CCXT sandbox mode before any other call (INV-1)', () => {
    const a = new BinanceTestnetAdapter({ apiKey: 'k', secret: 's' });
    // ccxt exposes the flag it was configured with
    expect((a as unknown as { exchange: { options: Record<string, unknown> } }).exchange.options.sandboxMode)
      .toBe(true);
  });

  it('declares paper mode and the crypto market', () => {
    const a = new BinanceTestnetAdapter({ apiKey: 'k', secret: 's' });
    expect(a.mode).toBe('paper');
    expect(a.market).toBe('CRYPTO');
    expect(a.venue).toBe('binance-testnet');
  });
});

// Live conformance run — requires BINANCE_TESTNET_KEY / _SECRET.
// Skipped automatically when credentials are absent so CI stays green offline.
const hasCreds = Boolean(process.env.BINANCE_TESTNET_KEY && process.env.BINANCE_TESTNET_SECRET);
if (hasCreds) {
  runConformanceSuite('BinanceTestnetAdapter', async () =>
    new BinanceTestnetAdapter({
      apiKey: process.env.BINANCE_TESTNET_KEY!,
      secret: process.env.BINANCE_TESTNET_SECRET!,
    }),
  );
} else {
  describe.skip('BinanceTestnetAdapter conformance (no credentials)', () => {
    it('skipped', () => {});
  });
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/brokers/src/binance-testnet`
Expected: FAIL — `Cannot find module './binance-testnet.js'`

- [ ] **Step 3: Implement the adapter**

```typescript
// packages/brokers/src/binance-testnet.ts
import ccxt, { type Exchange } from 'ccxt';
import type {
  BrokerAdapter, OrderRequest, VenueOrder, FillEvent, VenuePosition,
  Account, ReconciliationReport, Unsubscribe, OrderStatus,
} from './types.js';

const STATUS_MAP: Record<string, OrderStatus> = {
  open: 'submitted', closed: 'filled', canceled: 'cancelled', expired: 'cancelled', rejected: 'rejected',
};

export class BinanceTestnetAdapter implements BrokerAdapter {
  readonly venue = 'binance-testnet' as const;
  readonly market = 'CRYPTO' as const;
  readonly mode = 'paper' as const;

  private readonly exchange: Exchange;
  private streaming = false;

  constructor(opts: { apiKey: string; secret: string }) {
    this.exchange = new ccxt.binance({
      apiKey: opts.apiKey,
      secret: opts.secret,
      enableRateLimit: true,
    });
    // INV-1: MUST be called immediately after construction, before any other
    // call. CCXT swaps every base URL to the testnet host here.
    this.exchange.setSandboxMode(true);
  }

  async getAccount(): Promise<Account> {
    const bal = await this.exchange.fetchBalance();
    const usdt = bal.total?.['USDT'] ?? 0;
    return { equity: String(usdt), cash: String(bal.free?.['USDT'] ?? 0), currency: 'USDT' };
  }

  async getPositions(): Promise<VenuePosition[]> {
    const bal = await this.exchange.fetchBalance();
    return Object.entries(bal.total ?? {})
      .filter(([asset, qty]) => asset !== 'USDT' && Number(qty) > 0)
      .map(([asset, qty]) => ({ symbol: `${asset}/USDT`, qty: String(qty), avgCost: '0' }));
  }

  async submitOrder(req: OrderRequest): Promise<VenueOrder> {
    // Idempotency: Binance rejects a duplicate clientOrderId, which is exactly
    // the behaviour we want after a mid-submit restart. Look it up first.
    const existing = await this.findByClientId(req.clientOrderId, req.symbol);
    if (existing) return existing;

    const order = await this.exchange.createOrder(
      req.symbol, req.type === 'stop_limit' ? 'limit' : req.type, req.side,
      Number(req.qty),
      req.limitPrice !== undefined ? Number(req.limitPrice) : undefined,
      { clientOrderId: req.clientOrderId, ...(req.stopPrice ? { stopPrice: Number(req.stopPrice) } : {}) },
    );
    return this.toVenueOrder(order, req.clientOrderId);
  }

  private async findByClientId(clientOrderId: string, symbol: string): Promise<VenueOrder | null> {
    try {
      const o = await this.exchange.fetchOrder(clientOrderId, symbol, { clientOrderId });
      return this.toVenueOrder(o, clientOrderId);
    } catch { return null; }
  }

  private toVenueOrder(o: Record<string, unknown>, clientOrderId: string): VenueOrder {
    return {
      venueOrderId: String(o.id),
      clientOrderId,
      symbol: String(o.symbol),
      side: o.side as VenueOrder['side'],
      type: o.type as VenueOrder['type'],
      qty: String(o.amount ?? '0'),
      filledQty: String(o.filled ?? '0'),
      avgFillPrice: o.average != null ? String(o.average) : null,
      status: STATUS_MAP[String(o.status)] ?? 'submitted',
      submittedAt: new Date(Number(o.timestamp ?? Date.now())).toISOString(),
    };
  }

  async cancelOrder(venueOrderId: string): Promise<void> {
    await this.exchange.cancelOrder(venueOrderId);
  }

  async listOpenOrders(): Promise<VenueOrder[]> {
    const open = await this.exchange.fetchOpenOrders();
    return open.map((o) => this.toVenueOrder(o as Record<string, unknown>, String(o.clientOrderId ?? '')));
  }

  streamFills(onEvent: (e: FillEvent) => void): Unsubscribe {
    this.streaming = true;
    void (async () => {
      while (this.streaming) {
        try {
          const orders = await this.exchange.watchOrders();
          for (const o of orders) {
            if (o.filled && Number(o.filled) > 0) {
              onEvent({
                venueOrderId: String(o.id),
                venueFillId: `${o.id}:${o.filled}`,   // stable per cumulative fill level
                clientOrderId: String(o.clientOrderId ?? ''),
                symbol: String(o.symbol),
                side: o.side as FillEvent['side'],
                qty: String(o.filled),
                price: String(o.average ?? o.price ?? '0'),
                fee: String(o.fee?.cost ?? '0'),
                filledAt: new Date(Number(o.timestamp ?? Date.now())).toISOString(),
              });
            }
          }
        } catch {
          await new Promise((r) => setTimeout(r, 1000));   // reconnect backoff
        }
      }
    })();
    return () => { this.streaming = false; };
  }

  async reconcile(ledger: VenuePosition[]): Promise<ReconciliationReport> {
    const venue = await this.getPositions();
    const bySymbol = new Map(venue.map((p) => [p.symbol, p.qty]));
    const breaks: ReconciliationReport['breaks'] = [];
    const symbols = new Set([...ledger.map((l) => l.symbol), ...bySymbol.keys()]);
    for (const symbol of symbols) {
      const ledgerQty = ledger.find((l) => l.symbol === symbol)?.qty ?? '0';
      const venueQty = bySymbol.get(symbol) ?? '0';
      if (Math.abs(Number(ledgerQty) - Number(venueQty)) > 1e-8) {
        breaks.push({ symbol, ledgerQty, venueQty });
      }
    }
    return { matched: breaks.length === 0, breaks };
  }

  readonly calendar = { isOpen: () => true, nextOpen: (at: Date) => at, nextClose: (at: Date) => at };

  readonly constraints = {
    tickSize: () => '0.01',
    lotSize: () => '0.00001',
    minNotional: () => '10',
    supportsFractional: true,
    supportsShort: false,
    supportsBracket: false,
  };
}
```

- [ ] **Step 4: Run the unit tests (no credentials needed)**

Run: `pnpm vitest run packages/brokers/src/binance-testnet`
Expected: PASS, 2 tests; conformance suite reported as skipped

- [ ] **Step 5: Run the live conformance suite against the testnet**

Get keys from https://testnet.binance.vision (GitHub login, free, instant).

```bash
BINANCE_TESTNET_KEY=... BINANCE_TESTNET_SECRET=... pnpm vitest run packages/brokers/src/binance-testnet
```

Expected: PASS, 9 tests (2 unit + 7 conformance)

- [ ] **Step 6: Commit**

```bash
git add packages/brokers/src/binance-testnet.ts packages/brokers/src/binance-testnet.test.ts
git commit -m "feat(brokers): Binance testnet adapter with sandbox mode and idempotent submit"
```

---

### Task 6: Position ledger with lot accounting

**Files:**
- Create: `packages/ledger/package.json`, `packages/ledger/src/ledger.ts`, `packages/ledger/src/index.ts`
- Test: `packages/ledger/src/ledger.test.ts`

**Interfaces:**
- Consumes: `Db` from Task 3; `FillEvent` from Task 4
- Produces: `class Ledger` with `applyFill(fill: FillEvent, orderId: string): Promise<void>`, `getPosition(venue: string, symbol: string): Promise<LedgerPosition | null>`, `getAllPositions(venue: string): Promise<VenuePosition[]>`. `LedgerPosition` is `{ qty: string; avgCost: string; realisedPnl: string; lots: Lot[] }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/ledger/src/ledger.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Ledger } from './ledger.js';
import { getDb } from '@aegis/db';
import { randomUUID } from 'node:crypto';

const db = getDb(process.env.DATABASE_URL ?? 'postgres://aegis:aegis@localhost:5432/aegis');

function fill(over: Partial<Parameters<Ledger['applyFill']>[0]> = {}) {
  return {
    venueOrderId: randomUUID(), venueFillId: randomUUID(), clientOrderId: 'd:0',
    symbol: 'BTC/USDT', side: 'buy' as const, qty: '1', price: '100', fee: '0',
    filledAt: new Date().toISOString(), ...over,
  };
}

describe('Ledger', () => {
  let ledger: Ledger;
  let orderId: string;

  beforeEach(async () => {
    ledger = new Ledger(db, 'binance-testnet');
    orderId = await ledger.__testSeedOrder('BTC/USDT');
    await ledger.__testReset('BTC/USDT');
  });

  it('opens a position from the first buy fill', async () => {
    await ledger.applyFill(fill({ qty: '2', price: '100' }), orderId);
    const p = await ledger.getPosition('binance-testnet', 'BTC/USDT');
    expect(p!.qty).toBe('2');
    expect(p!.avgCost).toBe('100');
    expect(p!.lots).toHaveLength(1);
  });

  it('blends average cost across two buys', async () => {
    await ledger.applyFill(fill({ qty: '1', price: '100' }), orderId);
    await ledger.applyFill(fill({ qty: '1', price: '200' }), orderId);
    const p = await ledger.getPosition('binance-testnet', 'BTC/USDT');
    expect(p!.qty).toBe('2');
    expect(p!.avgCost).toBe('150');
  });

  it('sells the HIGHEST-cost lot first so the trim leg lowers average cost', async () => {
    await ledger.applyFill(fill({ qty: '1', price: '100' }), orderId);
    await ledger.applyFill(fill({ qty: '1', price: '300' }), orderId);
    await ledger.applyFill(fill({ qty: '1', price: '250', side: 'sell' }), orderId);
    const p = await ledger.getPosition('binance-testnet', 'BTC/USDT');
    expect(p!.qty).toBe('1');
    expect(p!.avgCost).toBe('100');           // the $300 lot went, not the $100 one
    expect(p!.realisedPnl).toBe('-50');       // sold a 300 lot at 250
  });

  it('is idempotent — replaying the same venueFillId changes nothing', async () => {
    const f = fill({ qty: '1', price: '100' });
    await ledger.applyFill(f, orderId);
    await ledger.applyFill(f, orderId);
    const p = await ledger.getPosition('binance-testnet', 'BTC/USDT');
    expect(p!.qty).toBe('1');
  });

  it('closes the position when quantity reaches zero', async () => {
    await ledger.applyFill(fill({ qty: '1', price: '100' }), orderId);
    await ledger.applyFill(fill({ qty: '1', price: '120', side: 'sell' }), orderId);
    const p = await ledger.getPosition('binance-testnet', 'BTC/USDT');
    expect(p!.qty).toBe('0');
    expect(p!.realisedPnl).toBe('20');
    expect(p!.closedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/ledger`
Expected: FAIL — `Cannot find module './ledger.js'`

- [ ] **Step 3: Implement the ledger**

Key decision encoded here: the trim leg sells the **highest-cost lot first**, per
the `position-ladder` framework — that is what makes trimming lower the blended
average rather than raise it. All arithmetic is `decimal.js`; no floats.

```typescript
// packages/ledger/src/ledger.ts
import Decimal from 'decimal.js';
import { eq, and, desc } from 'drizzle-orm';
import type { Db } from '@aegis/db';
import { positions, lots, fills } from '@aegis/db';
import type { FillEvent, VenuePosition } from '@aegis/brokers';

export interface Lot { id: string; remainingQty: string; costBasis: string; acquiredAt: string }
export interface LedgerPosition {
  qty: string; avgCost: string; realisedPnl: string; closedAt: string | null; lots: Lot[];
}

export class Ledger {
  constructor(private db: Db, private venue: string) {}

  async applyFill(fill: FillEvent, orderId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Idempotency (INV): the same WS event can arrive twice.
      const inserted = await tx.insert(fills).values({
        orderId, venueFillId: fill.venueFillId, qty: fill.qty,
        price: fill.price, fee: fill.fee, filledAt: new Date(fill.filledAt),
      }).onConflictDoNothing({ target: fills.venueFillId }).returning();
      if (inserted.length === 0) return;   // already applied
      const fillRow = inserted[0]!;

      let [pos] = await tx.select().from(positions)
        .where(and(eq(positions.venue, this.venue), eq(positions.symbol, fill.symbol)));
      if (!pos) {
        [pos] = await tx.insert(positions).values({
          venue: this.venue, symbol: fill.symbol, openedAt: new Date(fill.filledAt),
        }).returning();
      }
      const position = pos!;

      if (fill.side === 'buy') {
        await tx.insert(lots).values({
          positionId: position.id, fillId: fillRow.id,
          originalQty: fill.qty, remainingQty: fill.qty,
          costBasis: fill.price, acquiredAt: new Date(fill.filledAt),
        });
        const newQty = new Decimal(position.qty).plus(fill.qty);
        const newAvg = new Decimal(position.qty).times(position.avgCost)
          .plus(new Decimal(fill.qty).times(fill.price)).div(newQty);
        await tx.update(positions)
          .set({ qty: newQty.toString(), avgCost: newAvg.toString(), closedAt: null })
          .where(eq(positions.id, position.id));
        return;
      }

      // SELL — consume the highest-cost lots first (position-ladder trim rule).
      let remaining = new Decimal(fill.qty);
      let realised = new Decimal(position.realisedPnl);
      const openLots = await tx.select().from(lots)
        .where(eq(lots.positionId, position.id))
        .orderBy(desc(lots.costBasis));

      for (const lot of openLots) {
        if (remaining.lte(0)) break;
        const avail = new Decimal(lot.remainingQty);
        if (avail.lte(0)) continue;
        const take = Decimal.min(avail, remaining);
        realised = realised.plus(take.times(new Decimal(fill.price).minus(lot.costBasis)));
        await tx.update(lots)
          .set({ remainingQty: avail.minus(take).toString() })
          .where(eq(lots.id, lot.id));
        remaining = remaining.minus(take);
      }

      const newQty = new Decimal(position.qty).minus(fill.qty);
      const survivors = (await tx.select().from(lots).where(eq(lots.positionId, position.id)))
        .filter((l) => new Decimal(l.remainingQty).gt(0));
      const newAvg = survivors.length === 0
        ? new Decimal(0)
        : survivors.reduce((acc, l) => acc.plus(new Decimal(l.remainingQty).times(l.costBasis)), new Decimal(0))
            .div(survivors.reduce((acc, l) => acc.plus(l.remainingQty), new Decimal(0)));

      await tx.update(positions).set({
        qty: newQty.toString(),
        avgCost: newAvg.toString(),
        realisedPnl: realised.toString(),
        closedAt: newQty.isZero() ? new Date(fill.filledAt) : null,
      }).where(eq(positions.id, position.id));
    });
  }

  async getPosition(venue: string, symbol: string): Promise<LedgerPosition | null> {
    const [pos] = await this.db.select().from(positions)
      .where(and(eq(positions.venue, venue), eq(positions.symbol, symbol)));
    if (!pos) return null;
    const rows = await this.db.select().from(lots).where(eq(lots.positionId, pos.id));
    return {
      qty: pos.qty, avgCost: pos.avgCost, realisedPnl: pos.realisedPnl,
      closedAt: pos.closedAt?.toISOString() ?? null,
      lots: rows.filter((l) => new Decimal(l.remainingQty).gt(0)).map((l) => ({
        id: l.id, remainingQty: l.remainingQty, costBasis: l.costBasis,
        acquiredAt: l.acquiredAt.toISOString(),
      })),
    };
  }

  async getAllPositions(venue: string): Promise<VenuePosition[]> {
    const rows = await this.db.select().from(positions).where(eq(positions.venue, venue));
    return rows.filter((p) => new Decimal(p.qty).gt(0))
      .map((p) => ({ symbol: p.symbol, qty: p.qty, avgCost: p.avgCost }));
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `docker compose up -d && pnpm vitest run packages/ledger`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/ledger
git commit -m "feat(ledger): lot-accounting position ledger, highest-cost-first sells, idempotent fills"
```

---

### Task 7: Reconciliation loop with break detection

**Files:**
- Create: `packages/ledger/src/reconciler.ts`
- Modify: `packages/ledger/src/index.ts`
- Test: `packages/ledger/src/reconciler.test.ts`

**Interfaces:**
- Consumes: `Ledger` from Task 6, `BrokerAdapter` from Task 4, `FakeAdapter` for tests
- Produces: `class Reconciler` with `runOnce(): Promise<ReconciliationReport>` and `start(intervalMs: number): Unsubscribe`. Emits `onBreak(cb: (r: ReconciliationReport) => void)`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/ledger/src/reconciler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Reconciler } from './reconciler.js';
import { FakeAdapter } from '@aegis/brokers';

const stubLedger = (positions: Array<{ symbol: string; qty: string; avgCost: string }>) =>
  ({ getAllPositions: async () => positions }) as never;

describe('Reconciler', () => {
  it('reports matched when ledger and venue agree', async () => {
    const adapter = new FakeAdapter();
    await adapter.submitOrder({ clientOrderId: 'a:0', symbol: 'X', side: 'buy', type: 'market', qty: '5' });
    const r = new Reconciler(stubLedger([{ symbol: 'X', qty: '5', avgCost: '100' }]), adapter);
    const report = await r.runOnce();
    expect(report.matched).toBe(true);
  });

  it('detects a break and fires the callback exactly once per break', async () => {
    const adapter = new FakeAdapter();
    await adapter.submitOrder({ clientOrderId: 'b:0', symbol: 'X', side: 'buy', type: 'market', qty: '5' });
    const r = new Reconciler(stubLedger([{ symbol: 'X', qty: '7', avgCost: '100' }]), adapter);
    const onBreak = vi.fn();
    r.onBreak(onBreak);
    const report = await r.runOnce();
    expect(report.matched).toBe(false);
    expect(report.breaks[0]).toMatchObject({ symbol: 'X', ledgerQty: '7', venueQty: '5' });
    expect(onBreak).toHaveBeenCalledTimes(1);
  });

  it('persists every run, matched or not', async () => {
    const adapter = new FakeAdapter();
    const persisted: unknown[] = [];
    const r = new Reconciler(stubLedger([]), adapter, { persist: async (row) => { persisted.push(row); } });
    await r.runOnce();
    expect(persisted).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/ledger/src/reconciler`
Expected: FAIL — `Cannot find module './reconciler.js'`

- [ ] **Step 3: Implement the reconciler**

```typescript
// packages/ledger/src/reconciler.ts
import type { BrokerAdapter, ReconciliationReport, Unsubscribe } from '@aegis/brokers';
import type { Ledger } from './ledger.js';

interface ReconcilerDeps {
  persist?: (row: { venue: string; matched: boolean; breaks: ReconciliationReport['breaks'] }) => Promise<void>;
}

export class Reconciler {
  private callbacks = new Set<(r: ReconciliationReport) => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private ledger: Pick<Ledger, 'getAllPositions'>,
    private adapter: BrokerAdapter,
    private deps: ReconcilerDeps = {},
  ) {}

  onBreak(cb: (r: ReconciliationReport) => void): void { this.callbacks.add(cb); }

  async runOnce(): Promise<ReconciliationReport> {
    const ledgerPositions = await this.ledger.getAllPositions(this.adapter.venue);
    const report = await this.adapter.reconcile(ledgerPositions);
    await this.deps.persist?.({ venue: this.adapter.venue, matched: report.matched, breaks: report.breaks });
    if (!report.matched) for (const cb of this.callbacks) cb(report);
    return report;
  }

  /** A break must block new orders for this venue until resolved — the caller
   *  wires onBreak to the HALT flag. The ledger is our source of truth, but the
   *  venue is the arbiter: if they disagree, we stop, we do not guess. */
  start(intervalMs = 60_000): Unsubscribe {
    this.timer = setInterval(() => { void this.runOnce(); }, intervalMs);
    return () => { if (this.timer) clearInterval(this.timer); this.timer = null; };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/ledger`
Expected: PASS, 8 tests total

- [ ] **Step 5: Commit**

```bash
git add packages/ledger/src/reconciler.ts packages/ledger/src/reconciler.test.ts packages/ledger/src/index.ts
git commit -m "feat(ledger): 60s reconciliation loop with break detection and persistence"
```

---

### Task 8: Phase-1 gate — the hand-placed round trip

**Files:**
- Create: `scripts/phase1-smoke.ts`
- Test: manual, against the live Binance testnet

**Interfaces:**
- Consumes: everything from Tasks 1–7
- Produces: nothing — this is the acceptance gate for Phase 1

- [ ] **Step 1: Write the smoke script**

```typescript
// scripts/phase1-smoke.ts
import { loadConfig } from '@aegis/config';
import { getDb } from '@aegis/db';
import { BinanceTestnetAdapter } from '@aegis/brokers';
import { Ledger, Reconciler } from '@aegis/ledger';
import { randomUUID } from 'node:crypto';

const cfg = loadConfig(process.env);
const db = getDb(cfg.databaseUrl);
const adapter = new BinanceTestnetAdapter({
  apiKey: process.env.BINANCE_TESTNET_KEY!,
  secret: process.env.BINANCE_TESTNET_SECRET!,
});
const ledger = new Ledger(db, adapter.venue);

console.log('account:', await adapter.getAccount());

const decisionId = randomUUID();
const stop = adapter.streamFills(async (fill) => {
  console.log('FILL', fill);
  await ledger.applyFill(fill, decisionId);
  console.log('ledger:', await ledger.getPosition(adapter.venue, fill.symbol));
});

await adapter.submitOrder({
  clientOrderId: `${decisionId}:0`,
  symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: '0.001',
});

await new Promise((r) => setTimeout(r, 5000));

const rec = new Reconciler(ledger, adapter);
console.log('reconciliation:', await rec.runOnce());
stop();
process.exit(0);
```

- [ ] **Step 2: Run the gate**

```bash
docker compose up -d
TRADING_MODE=paper \
DATABASE_URL=postgres://aegis:aegis@localhost:5432/aegis \
REDIS_URL=redis://localhost:6379 \
BINANCE_TESTNET_KEY=... BINANCE_TESTNET_SECRET=... \
pnpm tsx scripts/phase1-smoke.ts
```

Expected output, in order: an account balance; a `FILL` line arriving over
WebSocket within a few seconds; a ledger position showing `qty: 0.001` with one
lot; and `reconciliation: { matched: true, breaks: [] }`.

- [ ] **Step 3: Verify the invariant holds under a hostile config**

```bash
TRADING_MODE=live DATABASE_URL=x REDIS_URL=y pnpm tsx scripts/phase1-smoke.ts
```

Expected: immediate `ConfigError: Invalid configuration for TRADING_MODE: only "paper" is permitted (INV-1); got "live"` and a non-zero exit. Nothing connects.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test`
Expected: PASS, all packages green

- [ ] **Step 5: Commit and tag the gate**

```bash
git add scripts/phase1-smoke.ts
git commit -m "chore: phase-1 smoke script — order round-trip and reconciliation gate"
git tag phase-1-gate
```

---

## What Phase 2 picks up

With the spine green, Phase 2 adds the Risk Officer (pure functions, property
tests), the Order Router (HALT check immediately before send, idempotency on
`(decisionId, rungIndex)` — the DB constraint from Task 3 already enforces it),
and the Notifier (outbox pattern in the same transaction as the state change).
No agent exists until Phase 3, and that is deliberate: everything that moves money
is proven before anything that thinks about it is written.
