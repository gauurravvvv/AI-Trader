import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { estimateCost, estimateTokens, type ModelId } from './pricing.js';

export interface AskOpts {
  model: ModelId;
  agent: string;
  timeoutMs?: number;
}

/**
 * The shape of `askClaude`, so callers can substitute one.
 *
 * The pipeline's end-to-end behaviour — gate ordering, signal consumption,
 * lineage, sizing — is worth testing on every commit, and none of it should
 * require a subprocess, a network, or a cent of metered credit to exercise.
 */
export type AskFn = (prompt: string, opts: AskOpts) => Promise<ClaudeResult>;

export interface ClaudeResult {
  /**
   * The model that actually produced this result. Carried on the result so the
   * budget ledger cannot be handed a different model than the one invoked —
   * hand-typing `model: 'haiku'` next to a sonnet call mis-prices it by 3x.
   */
  model: ModelId;
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: string;
  latencyMs: number;
  promptHash: string;
  /** Tokens served from the prompt cache. Zero means the cache missed. */
  cacheReadTokens: number;
  /** Tokens written to the cache. Large and repeated means it keeps missing. */
  cacheCreateTokens: number;
  /** False when the CLI gave no usage block and the cost had to be estimated. */
  costMeasured: boolean;
}

export class ClaudeError extends Error {
  constructor(
    msg: string,
    readonly code: 'TIMEOUT' | 'EXIT' | 'SPAWN',
    readonly stderr = '',
  ) {
    super(msg);
    this.name = 'ClaudeError';
  }
}

/**
 * Tools this process never wants the model to reach for.
 *
 * Every tool the CLI offers ships its schema in the system prompt and is billed
 * on every call. None of these are useful to an agent whose entire job is to
 * return JSON about a filing, and dropping them removes ~8k tokens per call.
 */
const UNUSED_TOOLS = [
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit',
];

const SYSTEM_PROMPT =
  'You are a precise financial analyst. Answer only what is asked, in the exact ' +
  'format requested. Never speculate beyond the text you are given.';

/**
 * Flags that decide what this system costs to run.
 *
 * Measured on this machine with `--output-format json`, steady state per trivial
 * haiku call:
 *
 *   default (no flags)                        $0.130
 *   + --strict-mcp-config                     $0.0043
 *   + --disallowed-tools                      $0.0034
 *   + --system-prompt                         $0.0028
 *
 * A 47x difference, and none of it is about the prompt we send. `claude -p`
 * loads Claude Code's own system prompt — every MCP server's tool schemas,
 * every built-in tool, and per-machine sections like cwd and git status — and
 * bills it as cache-creation input. The per-machine sections change between
 * invocations, so the default configuration invalidates its own cache on every
 * single call and pays full creation price forever.
 *
 * `--strict-mcp-config` is the big one: MCP tool schemas alone were over half
 * the context. Replacing the system prompt drops the rest and, because ours is
 * byte-identical every time, the cache finally holds.
 */
export function buildArgs(model: ModelId, prompt: string): string[] {
  return [
    '--print',
    '--model',
    model,
    '--output-format',
    'json',
    '--strict-mcp-config',
    '--disallowed-tools',
    UNUSED_TOOLS.join(' '),
    '--system-prompt',
    SYSTEM_PROMPT,
    '-p',
    prompt,
  ];
}

interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface CliEnvelope {
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: CliUsage;
}

export interface ParsedCli {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: string | null;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/**
 * Read the CLI's JSON envelope.
 *
 * `total_cost_usd` is what Anthropic actually billed, and it is the only number
 * worth recording. Estimating from our own prompt length understated the true
 * cost by more than two orders of magnitude, because the overwhelming majority
 * of every bill is Claude Code's system prompt rather than anything we wrote.
 *
 * Falls back to the raw text when the envelope is absent, so an older CLI or an
 * unexpected output mode degrades to the previous behaviour instead of failing.
 */
export function parseCliJson(stdout: string): ParsedCli | null {
  let env: CliEnvelope;
  try {
    env = JSON.parse(stdout) as CliEnvelope;
  } catch {
    return null;
  }
  if (typeof env.result !== 'string') return null;
  const u = env.usage ?? {};
  return {
    text: env.result,
    tokensIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    tokensOut: u.output_tokens ?? 0,
    costUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd.toFixed(6) : null,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreateTokens: u.cache_creation_input_tokens ?? 0,
  };
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

export function setConcurrency(n: number): void {
  maxConcurrent = n;
}

async function acquire(): Promise<void> {
  if (inFlight < maxConcurrent) {
    inFlight++;
    return;
  }
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
    const stdout = await run(prompt, opts);
    const promptHash = createHash('sha256').update(prompt).digest('hex').slice(0, 16);
    const latencyMs = Date.now() - started;
    const parsed = parseCliJson(stdout);

    if (parsed === null) {
      // No envelope: an older CLI, or a mode that printed bare text. Estimate,
      // and say the cost is an estimate so the budget can be read sceptically.
      const tokensIn = estimateTokens(prompt);
      const tokensOut = estimateTokens(stdout);
      return {
        model: opts.model, text: stdout, tokensIn, tokensOut,
        costUsd: estimateCost(opts.model, tokensIn, tokensOut),
        latencyMs, promptHash,
        cacheReadTokens: 0, cacheCreateTokens: 0, costMeasured: false,
      };
    }

    return {
      model: opts.model,
      text: parsed.text,
      tokensIn: parsed.tokensIn,
      tokensOut: parsed.tokensOut,
      costUsd: parsed.costUsd ?? estimateCost(opts.model, parsed.tokensIn, parsed.tokensOut),
      latencyMs,
      promptHash,
      cacheReadTokens: parsed.cacheReadTokens,
      cacheCreateTokens: parsed.cacheCreateTokens,
      costMeasured: parsed.costUsd !== null,
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
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const hard = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5000);
      hard.unref();
      reject(new ClaudeError(`claude timed out after ${timeoutMs}ms`, 'TIMEOUT', stderr));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new ClaudeError(`claude exited ${String(code)}`, 'EXIT', stderr.trim()));
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ClaudeError(`claude spawn failed: ${e.message}`, 'SPAWN'));
    });
  });
}
