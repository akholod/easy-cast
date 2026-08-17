import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');
const pkg = JSON.parse(read('package.json')) as Record<string, any>;

describe('package metadata', () => {
  it('publishes under the name and binaries fixed by DG1', () => {
    expect(pkg.name).toBe('easy-cast');
    expect(pkg.bin).toEqual({
      'easy-cast': 'dist/src/cli.js',
      ecast: 'dist/src/cli.js',
    });
  });

  it('is a public MIT ESM package on Node 22+ (DG2/D20)', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.license).toBe('MIT');
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.engines.node).toBe('>=22');
    expect(pkg.packageManager).toBe('pnpm@11.13.1');
  });

  it('ships the build output, the skill and the docs — and nothing else', () => {
    expect(pkg.files).toEqual(['dist/src', 'skills', 'README.md', 'LICENSE']);
  });

  // The README links into the skill, and a tarball whose links dangle is a
  // README that lies to whoever installed the package.
  it('ships the skill the README points at', () => {
    expect(read('skills/easy-cast/SKILL.md')).toContain('name: easy-cast');
    expect(read('skills/easy-cast/references/failures.md').length).toBeGreaterThan(0);
    expect(read('README.md')).toContain('skills/easy-cast/references/failures.md');
  });

  // `skills/<name>/SKILL.md` is what skill installers discover. The old `skill/`
  // was not, so the same file could only be read by someone who cloned the repo.
  it('puts the skill where an installer will find it', () => {
    expect(pkg.files).toContain('skills');
    expect(() => read('skills/easy-cast/SKILL.md')).not.toThrow();
  });
});

describe('typescript configuration', () => {
  const tsconfig = JSON.parse(read('tsconfig.json')) as Record<string, any>;
  const buildConfig = JSON.parse(read('tsconfig.build.json')) as Record<string, any>;

  it('typechecks sources, tests and probe scripts', () => {
    expect(tsconfig.include).toEqual(['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts']);
  });

  it('builds sources only, so dist never carries scripts/', () => {
    expect(buildConfig.include).toEqual(['src/**/*.ts']);
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.build.json');
  });

  it('uses NodeNext module resolution under strict mode', () => {
    expect(tsconfig.compilerOptions.module).toBe('NodeNext');
    expect(tsconfig.compilerOptions.moduleResolution).toBe('NodeNext');
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });
});

describe('repository hygiene', () => {
  const gitignore = read('.gitignore');

  it('ignores build output and transient state', () => {
    for (const entry of ['node_modules/', 'dist/', 'coverage/', '/.omc/', '.easy-cast/tmp/']) {
      expect(gitignore).toContain(entry);
    }
  });

  it('does not ignore the write-ahead journal, which may be committed on purpose', () => {
    const ignoresWholeStateDir = gitignore
      .split('\n')
      .some((line) => line.trim() === '.easy-cast/' || line.trim() === '/.easy-cast/');
    expect(ignoresWholeStateDir).toBe(false);
  });

  it('merges the append-only journal by union so no record is lost', () => {
    expect(read('.gitattributes')).toContain('.easy-cast/journal.jsonl merge=union');
  });
});
