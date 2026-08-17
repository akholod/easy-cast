import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { isOsInjected } from './support/os-injected-env.js';
import {
  accessSync,
  constants,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawnScrubbed, type SpawnScrubbedOptions, type SpawnScrubbedResult } from '../src/secret/spawn.js';
import { captureSource, type SourceSnapshot } from '../src/media/snapshot.js';
import { computeDigest } from '../src/media/digest.js';
import { convert, H264_PROFILE, NO_PROFILE_ID, type ConversionResult } from '../src/media/convert.js';
import { EasyCastError } from '../src/errors.js';

/** Resolved before any test rewrites PATH to stage a missing or stubbed ffmpeg. */
function which(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep walking.
    }
  }
  return undefined;
}

const FFMPEG = which('ffmpeg');
const FFPROBE = which('ffprobe');
const ENV_BIN = which('env');
const REAL_PATH = process.env.PATH ?? '';

const CEILING = 100 * 1024 * 1024;

let root: string;
let tmpDir: string;
/** Holds no ffmpeg, so the lookup genuinely finds nothing. */
let emptyBin: string;
/** Holds an executable named ffmpeg that is never run — the fake spawn stands in. */
let stubBin: string;
let snapshot: SourceSnapshot;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'easy-cast-convert-'));
  tmpDir = join(root, 'tmp');
  emptyBin = join(root, 'empty-bin');
  stubBin = join(root, 'stub-bin');
  mkdirSync(emptyBin);
  mkdirSync(stubBin);
  writeFileSync(join(stubBin, 'ffmpeg'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(stubBin, 'ffmpeg'), 0o755);

  const source = join(root, 'clip.webm');
  writeFileSync(source, 'pretend webm bytes');
  snapshot = captureSource(source);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  process.env.PATH = REAL_PATH;
});

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnScrubbedOptions;
}

function recorder(result: SpawnScrubbedResult) {
  const calls: RecordedCall[] = [];
  const spawn: typeof spawnScrubbed = async (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
  return { calls, spawn };
}

const failed: SpawnScrubbedResult = { stdout: '', stderr: 'boom', exitCode: 1 };
const silentlyEmpty: SpawnScrubbedResult = { stdout: '', stderr: '', exitCode: 0 };

describe('disabled-by-flag', () => {
  it('reports profile "none" and starts no child at all', async () => {
    const { calls, spawn } = recorder(failed);
    const result = await convert(snapshot, null, CEILING, { spawn, tmpDir });

    expect(result.converted).toBe(false);
    expect(result.degraded).toBe('disabled-by-flag');
    expect(result.effectiveProfileId).toBe(NO_PROFILE_ID);
    expect(result.path).toBe(snapshot.path);
    expect(calls).toEqual([]);
  });
});

describe('ffmpeg-missing', () => {
  it('degrades to the source when the lookup finds no ffmpeg', async () => {
    process.env.PATH = emptyBin;
    const { calls, spawn } = recorder(failed);
    const result = await convert(snapshot, H264_PROFILE, CEILING, { spawn, tmpDir });

    expect(result.converted).toBe(false);
    expect(result.degraded).toBe('ffmpeg-missing');
    expect(result.effectiveProfileId).toBe(NO_PROFILE_ID);
    expect(result.path).toBe(snapshot.path);
    expect(result.warning).toContain('ffmpeg');
    expect(calls).toEqual([]);
  });
});

describe('ffmpeg-failed', () => {
  it('degrades to the source when ffmpeg exits non-zero', async () => {
    process.env.PATH = stubBin;
    const { spawn } = recorder(failed);
    const result = await convert(snapshot, H264_PROFILE, CEILING, { spawn, tmpDir });

    expect(result.converted).toBe(false);
    expect(result.degraded).toBe('ffmpeg-failed');
    expect(result.effectiveProfileId).toBe(NO_PROFILE_ID);
    expect(result.path).toBe(snapshot.path);
    expect(result.warning).toContain('boom');
  });

  // Exit 0 with nothing written would otherwise hand the uploader a path to a
  // file that does not exist, turning a soft degradation into a crash.
  it('degrades when ffmpeg exits 0 but produces no output file', async () => {
    process.env.PATH = stubBin;
    const { spawn } = recorder(silentlyEmpty);
    const result = await convert(snapshot, H264_PROFILE, CEILING, { spawn, tmpDir });

    expect(result.degraded).toBe('ffmpeg-failed');
    expect(result.effectiveProfileId).toBe(NO_PROFILE_ID);
  });
});

describe('how ffmpeg is started', () => {
  // Works on the author's machine, fails for everyone else: with allowEnv [] the
  // child has no PATH, so a bare `ffmpeg` resolves only through libc's
  // /bin:/usr/bin fallback and a Homebrew or nix install reads as missing.
  it('spawns the absolute path it resolved, not the bare name', async () => {
    process.env.PATH = stubBin;
    const { calls, spawn } = recorder(failed);
    await convert(snapshot, H264_PROFILE, CEILING, { spawn, tmpDir });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(join(stubBin, 'ffmpeg'));
    expect(isAbsolute(calls[0]!.command)).toBe(true);
    expect(calls[0]!.command).not.toBe('ffmpeg');
  });

  it('passes the profile arguments through unchanged', async () => {
    process.env.PATH = stubBin;
    const { calls, spawn } = recorder(failed);
    await convert(snapshot, H264_PROFILE, CEILING, { spawn, tmpDir });

    expect(calls[0]!.args.join(' ')).toContain(H264_PROFILE.args.join(' '));
  });

  // Delegates to the real spawnScrubbed with the options convert chose, so this
  // observes an actual child's environment instead of restating the argument.
  it.skipIf(!ENV_BIN)('gives the child nothing this process was holding', async () => {
    process.env.PATH = stubBin;
    const seen: { options: SpawnScrubbedOptions; stdout: string }[] = [];
    const spawn: typeof spawnScrubbed = async (_command, _args, options) => {
      const result = await spawnScrubbed(ENV_BIN!, [], options);
      seen.push({ options, stdout: result.stdout });
      return result;
    };

    await convert(snapshot, H264_PROFILE, CEILING, { spawn, tmpDir });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.options.allowEnv).toEqual([]);
    // `env` prints one NAME=VALUE per line. Whatever the platform inserted of its
    // own accord is not something this process passed — see
    // test/support/os-injected-env.ts.
    const namesSeen = seen[0]!.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(0, line.indexOf('=')))
      .filter((name) => !isOsInjected(name));
    expect(namesSeen).toEqual([]);
  });
});

describe('the size ceiling', () => {
  it('fails hard only when the unconverted file is over it', async () => {
    const { spawn } = recorder(failed);
    await expect(convert(snapshot, null, snapshot.byteLength - 1, { spawn, tmpDir })).rejects.toBeInstanceOf(
      EasyCastError,
    );
    await expect(convert(snapshot, null, snapshot.byteLength, { spawn, tmpDir })).resolves.toMatchObject({
      degraded: 'disabled-by-flag',
    });
  });

  it('reports the failure as bad_args so the caller is told to change the call', async () => {
    process.env.PATH = emptyBin;
    const { spawn } = recorder(failed);
    const thrown = await convert(snapshot, H264_PROFILE, 1, { spawn, tmpDir }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(EasyCastError);
    expect((thrown as EasyCastError).reason).toBe('bad_args');
    expect((thrown as EasyCastError).context).toMatchObject({ degraded: 'ffmpeg-missing' });
  });
});

describe('the digest a run records', () => {
  // The bug this guards: recording the requested profile after a degraded run
  // filed WebM bytes under the mp4 profile's id, and the next run on a machine
  // with ffmpeg reused that URL where mp4 was intended.
  it('differs between a degraded and a successful run of the same bytes', async () => {
    process.env.PATH = emptyBin;
    const { spawn } = recorder(failed);
    const degradedRun = await convert(snapshot, H264_PROFILE, CEILING, { spawn, tmpDir });

    expect(computeDigest(snapshot, degradedRun.effectiveProfileId)).not.toBe(
      computeDigest(snapshot, H264_PROFILE.id),
    );
  });
});

interface Probe {
  readonly streams: readonly { readonly codec_name?: string; readonly tags?: Record<string, string> }[];
  readonly format: { readonly tags?: Record<string, string> };
}

/**
 * Written by the mp4 muxer itself rather than carried over: container brands,
 * the track handler, and ffmpeg's own version string.
 */
const MUXER_TAGS = new Set([
  'major_brand',
  'minor_version',
  'compatible_brands',
  'encoder',
  'language',
  'handler_name',
  'vendor_id',
]);

const SOURCE_MARKER = 'EASY-CAST-SOURCE';

describe.skipIf(!FFMPEG || !FFPROBE)('success, against a real ffmpeg', () => {
  let result: ConversionResult;
  let probe: Probe;

  beforeAll(async () => {
    const source = join(root, 'real.webm');
    const generated = await spawnScrubbed(
      FFMPEG!,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=160x120:rate=10',
        '-b:v',
        '200k',
        '-metadata',
        `title=${SOURCE_MARKER}-TITLE`,
        '-metadata',
        `comment=${SOURCE_MARKER}-COMMENT`,
        source,
      ],
      { allowEnv: [] },
    );
    if (generated.exitCode !== 0) throw new Error(`could not generate a fixture: ${generated.stderr}`);

    result = await convert(captureSource(source), H264_PROFILE, CEILING, { spawn: spawnScrubbed, tmpDir });

    const probed = await spawnScrubbed(
      FFPROBE!,
      ['-v', 'error', '-show_entries', 'format_tags:stream_tags:stream=codec_name', '-of', 'json', result.path],
      { allowEnv: [] },
    );
    if (probed.exitCode !== 0) throw new Error(`could not probe the output: ${probed.stderr}`);
    probe = JSON.parse(probed.stdout) as Probe;
  });

  it('reports the profile that was actually applied', () => {
    expect(result.converted).toBe(true);
    expect(result.degraded).toBeUndefined();
    expect(result.effectiveProfileId).toBe(H264_PROFILE.id);
  });

  it('leaves the output in place for the pipeline to clean up', () => {
    expect(result.path.startsWith(tmpDir)).toBe(true);
    expect(existsSync(result.path)).toBe(true);
  });

  it('encodes the video as h264', () => {
    expect(probe.streams.map((stream) => stream.codec_name)).toContain('h264');
  });

  it('carries no metadata over from the source', () => {
    const tags = [probe.format.tags ?? {}, ...probe.streams.map((stream) => stream.tags ?? {})];
    const entries = tags.flatMap((tag) => Object.entries(tag));

    expect(entries.map(([key]) => key.toLowerCase()).filter((key) => !MUXER_TAGS.has(key))).toEqual([]);
    expect(entries.filter(([, value]) => value.includes(SOURCE_MARKER))).toEqual([]);
  });
});
