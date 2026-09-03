import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseModelJson } from './parse.js';

const S = z.object({ ok: z.boolean(), n: z.number() });
const F = '`'.repeat(3); // triple backtick, built to avoid nesting issues in source

describe('parseModelJson', () => {
  it('parses clean JSON', () => {
    expect(parseModelJson('{"ok":true,"n":7}', S)).toEqual({ ok: true, value: { ok: true, n: 7 } });
  });

  it('strips markdown fences — haiku emits these despite instructions', () => {
    expect(parseModelJson(`${F}json\n{"ok":true,"n":7}\n${F}`, S).ok).toBe(true);
  });

  it('strips bare fences with no language tag', () => {
    expect(parseModelJson(`${F}\n{"ok":true,"n":7}\n${F}`, S).ok).toBe(true);
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
    for (const junk of ['', '{', '}{', F, 'null', '[[[']) {
      expect(() => parseModelJson(junk, S)).not.toThrow();
    }
  });
});
