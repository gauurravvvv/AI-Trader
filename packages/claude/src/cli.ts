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
    const text = await run(prompt, opts);
    const tokensIn = estimateTokens(prompt);
    const tokensOut = estimateTokens(text);
    return {
      model: opts.model,
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
