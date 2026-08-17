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

function filesUnder(directory: string, extensions: readonly string[]): string[] {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && extensions.some((suffix) => entry.name.endsWith(suffix)))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

const typescriptFiles = (directory: string): string[] => filesUnder(directory, ['.ts']);
const textFiles = (directory: string, extensions: readonly string[]): string[] =>
  filesUnder(directory, extensions);

const scanned = ['src', 'scripts', 'test'].flatMap(typescriptFiles);
const offenders = scanned.filter((file) => readFileSync(resolve(root, file), 'utf8').includes(FORBIDDEN));

/**
 * An attachment URL is a capability: it names bytes that can never be deleted,
 * and this repository is public. The probe scrubber redacts UUIDs out of the
 * observation log for that reason — but nothing stopped one being pasted into a
 * test fixture or a document, which is how the first one got in.
 *
 * The allowlist below holds fabricated ids only. Adding a real one to it is the
 * mistake this test exists to make visible.
 */
const ASSET_UUID = /user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const FABRICATED = new Set(['00000000-1111-2222-3333-444444444444']);

/**
 * Wider than the child-process scan above, and deliberately a separate list: a
 * URL is just as public in a document or a fixture as in a source file, and the
 * documents are where one is most likely to be pasted while explaining something.
 */
const PUBLISHED_TEXT = [
  ...['src', 'scripts', 'test', 'docs', 'fixtures', 'skills'].flatMap(typescriptFiles),
  ...['src', 'scripts', 'test', 'docs', 'fixtures', 'skills'].flatMap((directory) =>
    textFiles(directory, ['.md', '.json', '.jsonl']),
  ),
  'README.md',
];

describe('no real attachment id is committed', () => {
  const found = PUBLISHED_TEXT.flatMap((file) => {
    const text = readFileSync(resolve(root, file), 'utf8');
    return [...text.matchAll(ASSET_UUID)].map((match) => ({
      file,
      id: match[0].slice(match[0].lastIndexOf('/') + 1).toLowerCase(),
    }));
  });

  it('scans the documents and fixtures too, not only the sources', () => {
    expect(PUBLISHED_TEXT).toContain('docs/endpoint-semantics.md');
    expect(PUBLISHED_TEXT).toContain('fixtures/endpoint/observations.jsonl');
  });

  it('finds only ids that were made up for a fixture', () => {
    expect(found.filter((hit) => !FABRICATED.has(hit.id))).toEqual([]);
  });

  it('still finds the fabricated one, so the scan is not vacuous', () => {
    expect(found.length).toBeGreaterThan(0);
  });
});

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
