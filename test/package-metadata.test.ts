import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMMAND_VERBS, HELP } from '../src/cli-args.js';

const root = resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');
const pkg = JSON.parse(read('package.json')) as Record<string, any>;

const readMarkdownUnder = (relative: string): string => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.md') ? [readFileSync(path, 'utf8')] : [];
    });
  return walk(resolve(root, relative)).join('\n');
};

/** Whole word, so the verb `render` is not satisfied by the word "rendered". */
const mentions = (haystack: string, verb: string): boolean =>
  new RegExp(`\\b${verb}\\b`).test(haystack);

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

/**
 * A verb that ships undocumented is a verb nobody will use, and the skill is how
 * an agent learns the surface exists at all.
 *
 * Scoped to the shipped skill **directory**, not `SKILL.md` alone, and that is a
 * requirement rather than a weakening: `recover` has always been documented only
 * in `references/failures.md`, so the narrower assertion would be red on an
 * untouched tree. Matched as a whole word, because a substring check is a check
 * that cannot fail — `SKILL.md` was full of "rendered" and "rendering" long
 * before the `render` verb existed.
 */
describe('the shipped skill documents the CLI surface', () => {
  const skill = readMarkdownUnder('skills/easy-cast');
  /**
   * The synopsis block, not the whole of HELP. Searching the text for each verb
   * anywhere would be satisfied by a passing mention in the prose at the bottom,
   * so deleting a command's own usage line would go unnoticed — which is the one
   * thing this is for.
   */
  const synopsis = new Set([...HELP.matchAll(/^\s+easy-cast\s+([a-z-]+)/gm)].map((match) => match[1]));

  it.each(COMMAND_VERBS)('documents the %s verb in the shipped skill', (verb) => {
    expect(mentions(skill, verb)).toBe(true);
  });

  // Both directions: a verb with no usage line, and a usage line for a verb that
  // no longer exists.
  it('gives every verb its own line in the HELP synopsis, and no others', () => {
    expect([...synopsis].sort()).toEqual([...COMMAND_VERBS].sort());
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
