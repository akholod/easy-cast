import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReportSpec, pathsOf, REPORT_SPEC_VERSION, type ReportSpec } from '../src/report/spec.js';
import { renderReport, renderReportPreview, type ResolvedArtifact } from '../src/report/render-report.js';
import { harvestFiles, harvestSpec } from '../src/report/harvest.js';
import { assertEdited, readSpec, runCompose, runHarvest } from '../src/report/commands.js';

let dir: string;

const write = (name: string, content: string): string => {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const spec = (sections: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: REPORT_SPEC_VERSION, sections, ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easy-cast-report-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the report spec', () => {
  it('accepts a spec with sections, artifacts, a comparison and a fold', () => {
    const parsed = parseReportSpec(
      spec(
        [
          { heading: 'What this adds', text: 'prose', artifacts: [{ path: 'a.png', label: 'the list' }] },
          { heading: 'Change', compare: { before: { path: 'b.png' }, after: { path: 'c.png' } } },
          { heading: 'More', collapsed: true, artifacts: [{ path: 'd.png', label: 'empty state' }] },
        ],
        { title: 'A title' },
      ),
    );
    expect(parsed.title).toBe('A title');
    expect(parsed.sections).toHaveLength(3);
    expect(pathsOf(parsed)).toEqual(['a.png', 'b.png', 'c.png', 'd.png']);
  });

  // D19: a spec from a later format could mean something this renderer would get
  // subtly wrong, and the result is posted permanently.
  it.each([2, 0, '1', undefined, null])('refuses version %s rather than interpreting it', (version) => {
    expect(() =>
      parseReportSpec(JSON.stringify({ version, sections: [{ text: 'x' }] })),
    ).toThrow(/version/);
  });

  it.each([
    ['not json at all', /valid JSON/],
    ['[]', /must be a JSON object/],
    ['{"version":1}', /at least one section/],
    ['{"version":1,"sections":[]}', /at least one section/],
    ['{"version":1,"sections":[{}]}', /would render as nothing/],
    ['{"version":1,"sections":[{"artifacts":[{}]}]}', /path must be a non-empty string/],
    ['{"version":1,"sections":[{"artifacts":"nope"}]}', /must be an array/],
    ['{"version":1,"sections":[{"text":"x","collapsed":"yes"}]}', /true or false/],
  ])('refuses %s', (source, expected) => {
    expect(() => parseReportSpec(source)).toThrow(expected);
  });

  // A disclosure triangle labelled nothing tells the reviewer nothing about
  // whether it is worth opening.
  it('refuses a fold with no heading', () => {
    expect(() => parseReportSpec(spec([{ collapsed: true, text: 'hidden' }]))).toThrow(/no heading/);
  });

  it('lists each path once even when the spec names it twice', () => {
    const parsed = parseReportSpec(
      spec([
        { artifacts: [{ path: 'a.png' }, { path: 'a.png' }] },
        { compare: { before: { path: 'a.png' }, after: { path: 'b.png' } } },
      ]),
    );
    expect(pathsOf(parsed)).toEqual(['a.png', 'b.png']);
  });
});

const resolved = (entries: Record<string, ResolvedArtifact>): Map<string, ResolvedArtifact> =>
  new Map(Object.entries(entries));

const png = (url: string): ResolvedArtifact => ({ url, category: 'image' });
const mp4 = (url: string): ResolvedArtifact => ({ url, category: 'video' });

describe('rendering a report', () => {
  it('gives each artifact its own label rather than one caption for all of them', () => {
    const body = renderReport(
      parseReportSpec(
        spec([{ artifacts: [{ path: 'a.png', label: 'the stale count' }, { path: 'b.png', label: 'after' }] }]),
      ),
      resolved({ 'a.png': png('https://u/1'), 'b.png': png('https://u/2') }),
    );
    expect(body).toContain('![the stale count](https://u/1)');
    expect(body).toContain('![after](https://u/2)');
  });

  it('falls back to the file name when a label is missing', () => {
    const body = renderReport(
      parseReportSpec(spec([{ artifacts: [{ path: 'shots/empty-state.png' }] }])),
      resolved({ 'shots/empty-state.png': png('https://u/1') }),
    );
    expect(body).toContain('![empty-state.png](https://u/1)');
  });

  // Measured 2026-08-17: the native player appears only when the URL is the sole
  // content of its line.
  it('leaves a video URL alone on its line, with the label above it', () => {
    const body = renderReport(
      parseReportSpec(spec([{ artifacts: [{ path: 'clip.mp4', label: 'the flow' }] }])),
      resolved({ 'clip.mp4': mp4('https://u/v') }),
    );
    expect(body).toContain('the flow\n\nhttps://u/v');
    expect(body).not.toContain('![');
  });

  it('puts a comparison side by side, which is the only way to compare it', () => {
    const body = renderReport(
      parseReportSpec(
        spec([{ compare: { before: { path: 'b.png', label: 'Before' }, after: { path: 'a.png', label: 'After' } } }]),
      ),
      resolved({ 'b.png': png('https://u/b'), 'a.png': png('https://u/a') }),
    );
    expect(body).toContain('| Before | After |');
    expect(body).toContain('<img src="https://u/b" width="380">');
  });

  // A table cell is never a line of its own, so a video in one is a dead link.
  it('refuses to put a video in a comparison cell, and stacks the pair instead', () => {
    const body = renderReport(
      parseReportSpec(spec([{ compare: { before: { path: 'b.mp4' }, after: { path: 'a.png' } } }])),
      resolved({ 'b.mp4': mp4('https://u/v'), 'a.png': png('https://u/a') }),
    );
    expect(body).not.toContain('| --- | --- |');
    expect(body).toContain('https://u/v');
  });

  it('folds a collapsed section, with the blank lines GitHub needs to parse it', () => {
    const body = renderReport(
      parseReportSpec(spec([{ heading: 'Other states', collapsed: true, artifacts: [{ path: 'a.png' }] }])),
      resolved({ 'a.png': png('https://u/1') }),
    );
    expect(body).toContain('<details>\n<summary>Other states</summary>\n\n');
    expect(body).toContain('\n\n</details>');
    // The heading is the summary; repeating it above the fold is noise.
    expect(body).not.toContain('#### Other states');
  });

  // A label sits in a body that also carries the marker and ledger delimiters.
  it('escapes a label that would otherwise close its own bracket', () => {
    const body = renderReport(
      parseReportSpec(spec([{ artifacts: [{ path: 'a.png', label: 'oops](evil) [x' }] }])),
      resolved({ 'a.png': png('https://u/1') }),
    );
    expect(body).toContain('\\]\\(evil\\)');
    expect(body).toContain('(https://u/1)');
  });

  it('places both references when two paths hold the same bytes', () => {
    const parsed = parseReportSpec(
      spec([{ artifacts: [{ path: 'one.png', label: 'first' }, { path: 'copy.png', label: 'second' }] }]),
    );
    // Both resolve to the single asset the batch uploaded once.
    const body = renderReport(parsed, resolved({ 'one.png': png('https://u/1'), 'copy.png': png('https://u/1') }));
    expect(body).toContain('![first](https://u/1)');
    expect(body).toContain('![second](https://u/1)');
  });

  it('throws rather than rendering an artifact it has no result for', () => {
    expect(() =>
      renderReport(parseReportSpec(spec([{ artifacts: [{ path: 'missing.png' }] }])), resolved({})),
    ).toThrow(/no upload result/);
  });

  // A plausible fake URL would be a document that looks finished and is not.
  it('marks preview URLs unmistakably', () => {
    const body = renderReportPreview(
      parseReportSpec(spec([{ artifacts: [{ path: 'a.png' }] }])),
      () => 'image',
    );
    expect(body).toContain('NOT-UPLOADED-YET:a.png');
  });
});

describe('harvest', () => {
  it('finds media and ignores everything else', () => {
    write('shots/a.png', 'x');
    write('shots/clip.mp4', 'x');
    write('shots/notes.txt', 'x');
    write('shots/trace.zip', 'x');

    expect(harvestFiles([join(dir, 'shots')]).map((file) => file.path.replace(dir + '/', ''))).toEqual([
      'shots/a.png',
      'shots/clip.mp4',
    ]);
  });

  it('returns the same order twice, so a re-harvest is a readable diff', () => {
    write('shots/b.png', 'x');
    write('shots/a.png', 'x');
    const once = harvestFiles([join(dir, 'shots')]);
    const twice = harvestFiles([join(dir, 'shots')]);
    expect(once.map((f) => f.path)).toEqual(twice.map((f) => f.path));
    expect(once[0]!.path.endsWith('a.png')).toBe(true);
  });

  it('does not walk into node_modules or a dot directory', () => {
    write('shots/keep.png', 'x');
    write('shots/node_modules/skip.png', 'x');
    write('shots/.cache/skip.png', 'x');
    expect(harvestFiles([join(dir, 'shots')])).toHaveLength(1);
  });

  it('stops at the depth limit rather than descending forever', () => {
    write('shots/a/b/c/d/deep.png', 'x');
    expect(harvestFiles([join(dir, 'shots')], { maxDepth: 2 })).toHaveLength(0);
    expect(harvestFiles([join(dir, 'shots')], { maxDepth: 5 })).toHaveLength(1);
  });

  // A report nobody can read is not evidence.
  it('refuses a sweep larger than the limit instead of producing an unreadable report', () => {
    for (let index = 0; index < 6; index += 1) write(`shots/f${index}.png`, 'x');
    expect(() => harvestFiles([join(dir, 'shots')], { limit: 5 })).toThrow(/harvest limit/);
  });

  it('names a file directly as well as a directory', () => {
    const path = write('one.png', 'x');
    expect(harvestFiles([path])).toHaveLength(1);
  });

  it('leaves every label blank, and does not guess at structure', () => {
    write('shots/before.png', 'x');
    write('shots/after.png', 'x');
    const built = harvestSpec(harvestFiles([join(dir, 'shots')]));

    expect(built.sections).toHaveLength(1);
    expect(built.sections[0]!.compare).toBeUndefined();
    expect(built.sections[0]!.artifacts!.every((artifact) => artifact.label === '')).toBe(true);
  });

  it('produces a spec that parses, so harvest and report agree on the format', () => {
    write('shots/a.png', 'x');
    const built = harvestSpec(harvestFiles([join(dir, 'shots')]));
    expect(() => parseReportSpec(JSON.stringify(built))).not.toThrow();
  });
});

describe('harvest and compose upload nothing', () => {
  it('writes the spec where it was asked to and creates no assets', () => {
    write('shots/a.png', 'x');
    const out = join(dir, 'spec.json');
    const output = runHarvest([join(dir, 'shots')], { out });

    expect(output.command).toBe('harvest');
    expect(output.exitCode).toBe(0);
    expect(output.assetsCreated).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(() => parseReportSpec(readFileSync(out, 'utf8'))).not.toThrow();
  });

  it('prints the spec when there is nowhere to write it', () => {
    write('shots/a.png', 'x');
    const output = runHarvest([join(dir, 'shots')]);
    expect(output.body).toContain('"version": 1');
  });

  it('renders the comment that would be posted, and says the URLs are not real', () => {
    write('a.png', 'x');
    const path = write('spec.json', spec([{ artifacts: [{ path: 'a.png', label: 'the thing' }] }]));
    const output = runCompose(path);

    expect(output.command).toBe('compose');
    expect(output.assetsCreated).toBe(0);
    expect(output.body).toContain('![the thing](NOT-UPLOADED-YET:a.png)');
    expect(output.notes?.join(' ')).toContain('Nothing was uploaded');
  });

  it('refuses a spec naming a file GitHub would not accept, before anybody uploads it', () => {
    const path = write('spec.json', spec([{ artifacts: [{ path: 'notes.txt' }] }]));
    expect(() => runCompose(path)).toThrow(/does not accept/);
  });
});

describe('the placeholder guard', () => {
  it('refuses a spec nobody edited', () => {
    write('shots/a.png', 'x');
    const built = harvestSpec(harvestFiles([join(dir, 'shots')]));
    expect(() => assertEdited(built)).toThrow(/placeholder/);
  });

  it('accepts one where the placeholder text is gone', () => {
    const parsed = parseReportSpec(spec([{ text: 'what this shows', artifacts: [{ path: 'a.png' }] }]));
    expect(() => assertEdited(parsed)).not.toThrow();
  });
});

describe('the spec hash', () => {
  const hashOf = (source: string): string => {
    const path = write(`spec-${Math.abs(hash(source))}.json`, source);
    return readSpec(path).specHash;
  };
  // Deterministic stand-in for a random name; the content is what matters.
  function hash(text: string): number {
    let value = 0;
    for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0;
    return value;
  }

  it('ignores whitespace and key order, because neither is posted', () => {
    const a = hashOf('{"version":1,"sections":[{"text":"x","heading":"h"}]}');
    const b = hashOf('{\n  "sections": [ { "heading": "h", "text": "x" } ],\n  "version": 1\n}');
    expect(a).toBe(b);
  });

  // The composed text is as much the product as the bytes are. A token obtained
  // for one set of labels must not authorise posting another.
  it('changes when a label changes, even though the files do not', () => {
    const a = hashOf(spec([{ artifacts: [{ path: 'a.png', label: 'one' }] }]));
    const b = hashOf(spec([{ artifacts: [{ path: 'a.png', label: 'two' }] }]));
    expect(a).not.toBe(b);
  });

  it('changes when sections are reordered', () => {
    const a = hashOf(spec([{ text: 'first' }, { text: 'second' }]));
    const b = hashOf(spec([{ text: 'second' }, { text: 'first' }]));
    expect(a).not.toBe(b);
  });
});

describe('readSpec', () => {
  it('says which file it could not read rather than throwing a stack trace', () => {
    expect(() => readSpec(join(dir, 'nope.json'))).toThrow(/could not read the report spec/);
  });

  it('round-trips a spec through parse without losing a section', () => {
    const source = spec([
      { heading: 'a', artifacts: [{ path: 'x.png', label: 'l' }] },
      { heading: 'b', collapsed: true, text: 'folded' },
    ]);
    const path = write('spec.json', source);
    const { spec: parsed } = readSpec(path);
    expect(parsed.sections).toHaveLength(2);
    expect((parsed as ReportSpec).sections[1]!.collapsed).toBe(true);
  });
});
