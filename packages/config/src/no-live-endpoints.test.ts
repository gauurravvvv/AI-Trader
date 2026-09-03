// INV-1 build guard: a live broker hostname must never appear in our source.
//
// Matching is on a HOSTNAME BOUNDARY, not a bare substring. The live Alpaca host
// `api.alpaca.markets` is a substring of the legitimate paper host
// `paper-api.alpaca.markets`, so `text.includes(host)` flags our own correct
// config and the guard gets weakened to make the build pass. Requiring that the
// character before the match is not part of a hostname keeps the guard strict
// while letting the paper host through.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

const FORBIDDEN = [
  'api.alpaca.markets', // Alpaca LIVE
  'api.binance.com', // Binance LIVE
  'fapi.binance.com', // Binance LIVE futures
  'api.kite.trade', // Zerodha LIVE
];

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'reference',
  'coverage',
  'data',
  'docs',
]);
const EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.yaml', '.yml']);

/** Chars that can legally precede/follow a hostname label. */
function hostPattern(host: string): RegExp {
  const escaped = host.replace(/\./g, '\\.');
  return new RegExp(`(?<![A-Za-z0-9._-])${escaped}(?![A-Za-z0-9-])`);
}

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
    const patterns = FORBIDDEN.map((h) => [h, hostPattern(h)] as const);
    const offenders: string[] = [];
    for (const file of walk(root)) {
      if (file.endsWith('no-live-endpoints.test.ts')) continue; // names them legitimately
      const text = readFileSync(file, 'utf8');
      for (const [host, re] of patterns) {
        if (re.test(text)) offenders.push(`${file} :: ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the boundary matcher rejects the live host but allows the paper host', () => {
    const live = hostPattern('api.alpaca.markets');
    expect(live.test('https://api.alpaca.markets')).toBe(true);
    expect(live.test('"api.alpaca.markets"')).toBe(true);
    expect(live.test('https://paper-api.alpaca.markets')).toBe(false);
    expect(live.test('sandbox.api.alpaca.markets.example')).toBe(false);
  });
});
