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
  newsIntervalMin: number;
  maxFilingAgeDays: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxAnalysesPerDay: number;
  baseSizePct: number;
  analystModel: 'haiku' | 'sonnet' | 'opus';
  challengerModel: 'haiku' | 'sonnet' | 'opus';
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
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
  int = false,
): number {
  const v = env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(key, `expected a number, got ${JSON.stringify(v)}`);
  if (int && !Number.isInteger(n)) throw new ConfigError(key, `expected an integer, got ${n}`);
  if (n < min || n > max) throw new ConfigError(key, `expected ${min}-${max}, got ${n}`);
  return n;
}

const MODELS = ['haiku', 'sonnet', 'opus'] as const;

function model(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: (typeof MODELS)[number],
): (typeof MODELS)[number] {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!(MODELS as readonly string[]).includes(raw)) {
    throw new ConfigError(key, `must be one of ${MODELS.join(', ')}; got ${JSON.stringify(raw)}`);
  }
  return raw as (typeof MODELS)[number];
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // INV-1. Case-sensitive on purpose: "Paper" is a typo, not an intent.
  const mode = required(env, 'TRADING_MODE');
  if (mode !== 'paper') {
    throw new ConfigError(
      'TRADING_MODE',
      `only "paper" is permitted (INV-1); got ${JSON.stringify(mode)}`,
    );
  }

  const level = env.LOG_LEVEL ?? 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new ConfigError(
      'LOG_LEVEL',
      `expected one of ${LOG_LEVELS.join('/')}, got ${JSON.stringify(level)}`,
    );
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
  // Minutes between news sweeps. The single biggest lever on monthly spend:
  // a measured tick costs ~$0.0146, so halving this doubles the news bill.
  newsIntervalMin: num(env, 'NEWS_INTERVAL_MIN', 20, 2, 720, true),
  // Filings older than this are not read. Drift is concentrated in the days
  // after a release; reading a two-month-old filing costs sonnet money for an
  // edge that was priced long ago.
  maxFilingAgeDays: num(env, 'MAX_FILING_AGE_DAYS', 10, 1, 120, true),
  // How many positions may be held at once. Bounds total exposure.
  maxOpenPositions: num(env, 'MAX_OPEN_POSITIONS', 8, 1, 100, true),
  // How many NEW entries per day. Bounds churn and model spend, which the
  // position cap alone does not.
  maxTradesPerDay: num(env, 'MAX_TRADES_PER_DAY', 5, 1, 100, true),
  // Analyst/challenger pairs per day. The main cost control: this is the only
  // agent that can spend without bound, since every other one is either
  // arithmetic or reads a fixed-size batch.
  maxAnalysesPerDay: num(env, 'MAX_ANALYSES_PER_DAY', 12, 1, 200, true),
  // Fraction of equity per trade BEFORE debate strength and regime scaling.
  baseSizePct: num(env, 'BASE_SIZE_PCT', 0.03, 0.001, 0.2),
  // Measured: haiku ~$0.003/call, sonnet ~$0.05 even warm. Cheap model forms
  // the view, expensive model holds the veto.
  analystModel: model(env, 'ANALYST_MODEL', 'haiku'),
  challengerModel: model(env, 'CHALLENGER_MODEL', 'sonnet'),
    dashboardPort: num(env, 'DASHBOARD_PORT', 3777, 1024, 65_535, true),
  };
}
