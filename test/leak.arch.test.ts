import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The choke point is only a choke point while it is the only door (P3). A second
 * module that starts its own child process would inherit the whole environment
 * by default, so this is checked statically rather than left to review.
 */

const root = resolve(import.meta.dirname, '..');

/** Assembled at runtime so this file does not match the rule it enforces. */
const FORBIDDEN = ['child', 'process'].join('_');

const ALLOWED = new Set([
  'src/secret/spawn.ts',
  // Has to observe a real child's argv and needs an unscrubbed spawn as the
  // control that proves the observation would catch a leak.
  'test/leak.argv.test.ts',
]);

function typescriptFiles(directory: string): string[] {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

const scanned = ['src', 'scripts', 'test'].flatMap(typescriptFiles);
const offenders = scanned.filter((file) => readFileSync(resolve(root, file), 'utf8').includes(FORBIDDEN));

describe('child processes start in exactly one place', () => {
  it('scans the sources, the probe scripts and the tests', () => {
    expect(scanned).toContain('src/secret/spawn.ts');
    expect(scanned.length).toBeGreaterThan(1);
  });

  it('finds no importer outside the allowlist', () => {
    expect(offenders.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });

  it('still finds the one module that is allowed to, so the scan is not vacuous', () => {
    expect(offenders).toContain('src/secret/spawn.ts');
  });
});
