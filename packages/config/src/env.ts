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
    dashboardPort: num(env, 'DASHBOARD_PORT', 3777, 1024, 65_535, true),
  };
}
