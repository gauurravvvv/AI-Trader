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
