import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Production code must not import a test runner.
 *
 * conformance.ts legitimately imports vitest, but it was re-exported from
 * index.ts, so the daemon pulled vitest in at startup and died with
 * "Vitest failed to access its internal state". Anything reachable from the
 * package entry point ships to production.
 */
describe('production export surface', () => {
  it('the package index does not reach any vitest-importing module', () => {
    const dir = import.meta.dirname;
    const index = readFileSync(join(dir, 'index.ts'), 'utf8');
    const reExported = [...index.matchAll(/from '\.\/([\w-]+)\.js'/g)].map((m) => m[1]!);

    const offenders: string[] = [];
    for (const mod of new Set(reExported)) {
      const src = readFileSync(join(dir, `${mod}.ts`), 'utf8');
      if (/from ['"]vitest['"]/.test(src)) offenders.push(`${mod}.ts`);
    }
    expect(offenders).toEqual([]);
  });

  it('no non-test source file outside conformance imports vitest', () => {
    const dir = import.meta.dirname;
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'conformance.ts')
      .filter((f) => /from ['"]vitest['"]/.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
