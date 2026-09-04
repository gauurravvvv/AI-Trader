import { describe, it, expect } from 'vitest';
import { buildArgs, sanitiseEnv, parseCliJson } from './cli.js';

describe('buildArgs', () => {
  it('uses --print and passes the model and prompt', () => {
    const a = buildArgs('sonnet', 'hello');
    expect(a[0]).toBe('--print');
    expect(a[a.indexOf('--model') + 1]).toBe('sonnet');
    expect(a[a.indexOf('-p') + 1]).toBe('hello');
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

describe('ClaudeResult', () => {
  it('is typed to carry the model that produced it', async () => {
    // Compile-time guarantee: the budget ledger reads r.model rather than a
    // hand-typed literal, so a sonnet call cannot be priced as haiku.
    const { askClaude } = await import('./cli.js');
    type R = Awaited<ReturnType<typeof askClaude>>;
    const probe: Pick<R, 'model'> = { model: 'sonnet' };
    expect(probe.model).toBe('sonnet');
  });
});

describe('buildArgs — the flags that decide what this costs', () => {
  it('replaces the default system prompt so the cache prefix is stable', () => {
    // The default prompt embeds cwd and git status, which change between runs
    // and invalidate the cache on every single call.
    const a = buildArgs('haiku', 'x');
    expect(a).toContain('--system-prompt');
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--disallowed-tools');
  });

  it('asks for JSON so the real billed cost comes back', () => {
    const a = buildArgs('haiku', 'x');
    expect(a.join(' ')).toContain('--output-format json');
  });

  it('produces byte-identical flags for the same model — a varying prefix would never cache', () => {
    const a = buildArgs('sonnet', 'prompt one');
    const b = buildArgs('sonnet', 'prompt two');
    expect(a.slice(0, a.indexOf('-p'))).toEqual(b.slice(0, b.indexOf('-p')));
  });

  it('keeps the prompt last so nothing can be read as a flag', () => {
    const a = buildArgs('haiku', '--help');
    expect(a.at(-2)).toBe('-p');
    expect(a.at(-1)).toBe('--help');
  });
});

describe('parseCliJson', () => {
  const envelope = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      result: 'ok',
      is_error: false,
      total_cost_usd: 0.002764,
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_read_input_tokens: 27414,
        cache_creation_input_tokens: 0,
      },
      ...over,
    });

  it('takes the billed cost from the CLI rather than estimating it', () => {
    // Estimating from our own prompt length understated the true cost by more
    // than two orders of magnitude: the bill is dominated by Claude Code's own
    // system prompt, not by anything we wrote.
    const p = parseCliJson(envelope())!;
    expect(p.costUsd).toBe('0.002764');
    expect(p.text).toBe('ok');
  });

  it('counts cached tokens as input — they were read, and they were billed', () => {
    const p = parseCliJson(envelope())!;
    expect(p.tokensIn).toBe(27417);
    expect(p.cacheReadTokens).toBe(27414);
    expect(p.cacheCreateTokens).toBe(0);
  });

  it('surfaces a cache miss, which is the expensive case', () => {
    const p = parseCliJson(envelope({
      total_cost_usd: 0.130241,
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 65109 },
    }))!;
    expect(p.cacheReadTokens).toBe(0);
    expect(p.cacheCreateTokens).toBe(65109);
  });

  it('returns null for bare text so an older CLI still works', () => {
    expect(parseCliJson('just some text')).toBeNull();
  });

  it('returns null when the envelope has no result field', () => {
    expect(parseCliJson('{"usage":{}}')).toBeNull();
  });

  it('reports no cost rather than zero when the CLI omits it', () => {
    const p = parseCliJson(envelope({ total_cost_usd: undefined }))!;
    expect(p.costUsd).toBeNull();
  });

  it('survives a missing usage block', () => {
    const p = parseCliJson('{"result":"ok"}')!;
    expect(p.tokensIn).toBe(0);
    expect(p.costUsd).toBeNull();
  });
});
