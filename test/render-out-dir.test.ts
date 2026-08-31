import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPORT_SPEC_VERSION } from '../src/report/spec.js';
import { runRender, type Manifest } from '../src/report/render-local.js';
import { computeDigest, computeSourceHash } from '../src/media/digest.js';
import { captureSource } from '../src/media/snapshot.js';
import { parseArgs } from '../src/cli-args.js';

/**
 * Named for the verb's output rather than its module: `test/render.test.ts`
 * already covers the human/JSON output renderer, and two files called "render"
 * would read as two tests of one thing.
 */

let dir: string;
let out: string;

const write = (name: string, content: string | Buffer): string => {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const spec = (sections: unknown, extra: Record<string, unknown> = {}): string =>
  write('spec.json', JSON.stringify({ version: REPORT_SPEC_VERSION, sections, ...extra }));

const manifestOf = (): Manifest => JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Manifest;
const reportOf = (): string => readFileSync(join(out, 'report.md'), 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easy-cast-render-'));
  out = join(dir, 'out');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('render --out-dir', () => {
  it('writes report.md, spec.json, manifest.json and copies of the artifacts', () => {
    write('a.png', 'alpha');
    const specPath = spec([{ heading: 'One', artifacts: [{ path: join(dir, 'a.png'), label: 'the list' }] }]);

    const output = runRender(specPath, out);

    expect(output.command).toBe('render');
    expect(output.exitCode).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['assets', 'manifest.json', 'report.md', 'spec.json']);
    expect(reportOf()).toContain('![the list](assets/');
  });

  // The whole point of a folder is that it survives being moved or zipped, so
  // every link has to be relative to the out-dir and resolve inside it.
  it('links relatively, and every link resolves against the out-dir', () => {
    write('a.png', 'alpha');
    write('b.png', 'beta');
    const specPath = spec([
      { artifacts: [{ path: join(dir, 'a.png'), label: 'first' }, { path: join(dir, 'b.png'), label: 'second' }] },
    ]);

    runRender(specPath, out);

    const links = [...reportOf().matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    expect(links.length).toBe(2);
    for (const link of links) {
      expect(link.startsWith('assets/')).toBe(true);
      expect(link.includes('..')).toBe(false);
      expect(readdirSync(join(out, 'assets'))).toContain(link.slice('assets/'.length));
    }
  });

  // Mirrors report.test.ts's 'places both references when two paths hold the
  // same bytes': one asset, referenced wherever the spec puts it.
  it('copies once and references twice when two paths hold the same bytes', () => {
    write('one.png', 'identical');
    write('copy.png', 'identical');
    const specPath = spec([
      { artifacts: [{ path: join(dir, 'one.png'), label: 'first' }, { path: join(dir, 'copy.png'), label: 'second' }] },
    ]);

    runRender(specPath, out);

    expect(readdirSync(join(out, 'assets')).length).toBe(1);
    expect(manifestOf().artifacts.length).toBe(1);
    const asset = readdirSync(join(out, 'assets'))[0];
    expect(reportOf()).toContain(`![first](assets/${asset})`);
    expect(reportOf()).toContain(`![second](assets/${asset})`);
  });

  // Inherited from render-report.ts rather than re-implemented: a video URL that
  // shares its line with anything else renders as a dead link, not a player.
  // This is what makes a local render promote to a comment unchanged.
  it('puts a video URL alone on its own line', () => {
    write('clip.mp4', 'video bytes');
    const specPath = spec([{ artifacts: [{ path: join(dir, 'clip.mp4'), label: 'the flow' }] }]);

    runRender(specPath, out);

    const line = reportOf()
      .split('\n')
      .find((candidate) => candidate.includes('.mp4'));
    expect(line).toBeDefined();
    expect(line!.trim()).toMatch(/^assets\/[0-9a-f]{12}-clip\.mp4$/);
  });

  it('renders a comparison as a two-column table', () => {
    write('before.png', 'b');
    write('after.png', 'a');
    const specPath = spec([
      {
        heading: 'The change',
        compare: {
          before: { path: join(dir, 'before.png'), label: 'Before: no filter' },
          after: { path: join(dir, 'after.png'), label: 'After: filtered' },
        },
      },
    ]);

    runRender(specPath, out);

    expect(reportOf()).toContain('| Before: no filter | After: filtered |');
    expect(reportOf()).toContain('| --- | --- |');
    // The cells carry raw <img src="...">, which is the other place a relative
    // path has to land — and the place an unsanitised filename would escape.
    const sources = [...reportOf().matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]);
    expect(sources.length).toBe(2);
    for (const source of sources) {
      expect(source).toMatch(/^assets\/[0-9a-f]{12}-[A-Za-z0-9._-]+$/);
      expect(readdirSync(join(out, 'assets'))).toContain(source.slice('assets/'.length));
    }
  });

  // sourceHash names the bytes the caller pointed at. It is deliberately NOT the
  // ledger key (`sha256(bytes):<effectiveProfileId>`), which a local render
  // cannot compute because it applies no conversion profile.
  it('records sourceHash, not the ledger key', () => {
    const path = write('a.png', 'alpha');
    const specPath = spec([{ artifacts: [{ path, label: 'x' }] }]);

    runRender(specPath, out);

    const [artifact] = manifestOf().artifacts;
    const snapshot = captureSource(path);
    expect(artifact.sourceHash).toBe(computeSourceHash(snapshot));
    // The distinction that matters: the ledger key carries the conversion profile
    // that was actually applied, and a local render applies none.
    expect(artifact.sourceHash).not.toBe(computeDigest(snapshot, 'mp4-h264'));
    expect(artifact.bytes).toBe(5);
    expect(artifact.category).toBe('image');
  });

  // D16: everything downstream comes from one read. Re-reading the path to copy
  // it would let manifest.json describe bytes that assets/ does not hold.
  it('writes the bytes it hashed, even if the source changes underneath', () => {
    const path = write('a.png', 'original');
    const specPath = spec([{ artifacts: [{ path, label: 'x' }] }]);

    // Stand in for a file being rewritten mid-run: the manifest and the asset
    // must still agree with each other.
    runRender(specPath, out);
    writeFileSync(path, 'REWRITTEN AFTER THE RUN');

    const [artifact] = manifestOf().artifacts;
    const written = readFileSync(join(out, artifact.assetPath));
    expect(written.toString()).toBe('original');
    expect(artifact.sourceHash).toBe(computeSourceHash({ bytes: written } as never));
    expect(artifact.bytes).toBe(written.byteLength);
  });

  // prepare() classifies the canonical bytes once, so identical content cannot
  // render as an image locally and a video in a comment.
  it('gives identical bytes one canonical category, whatever they are named', () => {
    write('frame.png', 'same bytes');
    write('clip.mp4', 'same bytes');
    const specPath = spec([
      { artifacts: [{ path: join(dir, 'frame.png'), label: 'a' }, { path: join(dir, 'clip.mp4'), label: 'b' }] },
    ]);

    runRender(specPath, out);

    const [artifact] = manifestOf().artifacts;
    expect(manifestOf().artifacts.length).toBe(1);
    expect(readdirSync(join(out, 'assets')).length).toBe(1);
    // The point is not the count: it is that the *first* occurrence decides the
    // category for both paths, so the pair cannot render as an image here and a
    // video in a comment.
    expect(artifact.category).toBe('image');
    expect(artifact.sourcePaths).toEqual([join(dir, 'frame.png'), join(dir, 'clip.mp4')]);
    expect(reportOf()).toContain(`![a](${artifact.assetPath})`);
    expect(reportOf()).toContain(`![b](${artifact.assetPath})`);
  });

  // A quote or a bracket in a filename would escape the raw <img src="..."> that
  // a comparison table emits.
  it('sanitises the asset filename', () => {
    write('a "weird" (name).png', 'alpha');
    const specPath = spec([{ artifacts: [{ path: join(dir, 'a "weird" (name).png'), label: 'x' }] }]);

    runRender(specPath, out);

    const [asset] = readdirSync(join(out, 'assets'));
    expect(asset).toMatch(/^[0-9a-f]{12}-a--weird---name-\.png$/);
    // And the report references it by that exact name, so nothing dangles.
    expect(reportOf()).toContain(`assets/${asset}`);
  });

  it('copies spec.json verbatim', () => {
    write('a.png', 'alpha');
    const specPath = spec([{ artifacts: [{ path: join(dir, 'a.png'), label: 'x' }] }]);

    runRender(specPath, out);

    expect(readFileSync(join(out, 'spec.json'), 'utf8')).toBe(readFileSync(specPath, 'utf8'));
  });

  // Exercises the cleanup `catch`, not just the pre-flight refusal. A 250-character
  // filename is legal, so prepare() reads it happily; prefixing 13 characters of
  // hash pushes the asset name past NAME_MAX and writeFileSync fails *inside*
  // staging. No mock — a real ENAMETOOLONG from the filesystem.
  it('leaves nothing behind when a write fails part-way through staging', () => {
    const longName = `${'n'.repeat(250)}.png`;
    const path = write(longName, 'alpha');
    const specPath = spec([{ artifacts: [{ path, label: 'x' }] }]);

    expect(() => runRender(specPath, out)).toThrow(/ENAMETOOLONG/);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir).filter((entry) => entry.startsWith('.easy-cast-render-'))).toEqual([]);
  });

  // A half-written directory is worse than none: the next run refuses it as
  // non-empty and the caller is stuck holding evidence that looks complete.
  it('leaves nothing behind when a file in the spec cannot be read', () => {
    write('a.png', 'alpha');
    const specPath = spec([
      { artifacts: [{ path: join(dir, 'a.png'), label: 'ok' }, { path: join(dir, 'gone.png'), label: 'missing' }] },
    ]);

    expect(() => runRender(specPath, out)).toThrow();
    expect(existsSync(out)).toBe(false);
    // And no staging directory is orphaned beside it either.
    expect(readdirSync(dir).filter((entry) => entry.startsWith('.easy-cast-render-'))).toEqual([]);
  });

  it('reports command render, creates no assets, and names the destination in notes', () => {
    write('a.png', 'alpha');
    const specPath = spec([{ artifacts: [{ path: join(dir, 'a.png'), label: 'x' }] }]);

    const output = runRender(specPath, out);

    expect(output.command).toBe('render');
    expect(output.assetsCreated).toBe(0);
    expect(output.uploaded).toEqual([]);
    expect(output.notes?.join('\n')).toContain(out);
    expect(output.notes?.join('\n')).toContain('report.md');
  });

  // The reversible branch is free: name another directory. That is why there is
  // no --force.
  it('refuses a non-empty out-dir', () => {
    write('a.png', 'alpha');
    const specPath = spec([{ artifacts: [{ path: join(dir, 'a.png'), label: 'x' }] }]);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'someone-elses-file'), 'x');

    expect(() => runRender(specPath, out)).toThrow(/not empty/);
  });

  // A spec nobody opened the files for is refused whether the destination is
  // permanent or not.
  it('refuses a spec still carrying harvest’s placeholder', () => {
    write('a.png', 'alpha');
    const specPath = spec([{ text: 'REPLACE THIS', artifacts: [{ path: join(dir, 'a.png') }] }]);

    expect(() => runRender(specPath, out)).toThrow(/placeholder/);
  });

  // Accepting locally what report would refuse would produce a spec that renders
  // and then fails at the moment it matters.
  it('refuses a file type GitHub does not accept', () => {
    write('notes.txt', 'plain text');
    const specPath = spec([{ artifacts: [{ path: join(dir, 'notes.txt') }] }]);

    expect(() => runRender(specPath, out)).toThrow(/not a file type GitHub accepts/);
  });
});

describe('render argument refusals', () => {
  const refuses = (argv: readonly string[], pattern: RegExp): void => {
    expect(() => parseArgs(argv)).toThrow(pattern);
  };

  it('refuses --to, because it posts nowhere', () => {
    refuses(['render', '--spec', 's.json', '--out-dir', 'd', '--to', 'issue:1'], /takes no --to/);
  });

  // Declared, not swept (D24).
  it('refuses positional files, so it can never sweep a directory', () => {
    refuses(['render', '--spec', 's.json', '--out-dir', 'd', 'a.png'], /files from the spec/);
  });

  it('needs both --spec and --out-dir', () => {
    refuses(['render', '--out-dir', 'd'], /needs --spec/);
    refuses(['render', '--spec', 's.json'], /needs --out-dir/);
  });

  it('refuses the comment flags, which would go nowhere', () => {
    refuses(['render', '--spec', 's.json', '--out-dir', 'd', '--caption', 'hi'], /no comment/);
    refuses(['render', '--spec', 's.json', '--out-dir', 'd', '--key', 'k'], /no comment/);
  });

  it('refuses --allow-public, which would gate nothing', () => {
    refuses(['render', '--spec', 's.json', '--out-dir', 'd', '--allow-public'], /gate nothing/);
  });

  // Comes from MUTATING_COMMANDS, which render is deliberately not in.
  it('refuses --confirm-plan, because there is no plan', () => {
    refuses(['render', '--spec', 's.json', '--out-dir', 'd', '--confirm-plan=x'], /uploads nothing/);
  });

  // Accepted-and-ignored is the worse answer: a caller who passed it believes a
  // preview happened.
  it('refuses --dry-run, because there is nothing to preview', () => {
    refuses(['render', '--spec', 's.json', '--out-dir', 'd', '--dry-run'], /nothing to preview/);
    refuses(['compose', '--spec', 's.json', '--dry-run'], /nothing to preview/);
  });

  it('keeps --out-dir off every other command', () => {
    refuses(['harvest', 'media', '--out-dir', 'd'], /belongs to render/);
  });

  it('accepts the shape it is meant to accept', () => {
    const parsed = parseArgs(['render', '--spec', 's.json', '--out-dir', 'd']);
    expect(parsed.command).toBe('render');
    expect(parsed.spec).toBe('s.json');
    expect(parsed.outDir).toBe('d');
  });
});
