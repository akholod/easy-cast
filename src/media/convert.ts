import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { badArgs } from '../errors.js';
import type { spawnScrubbed } from '../secret/spawn.js';
import { computeSourceHash } from './digest.js';
import type { SourceSnapshot } from './snapshot.js';

/**
 * WebM/VP8 is what `playwright-cli` records and what Safari plays unpredictably,
 * so video is converted by default. `ffmpeg` is a recommended dependency, not a
 * required one: every way conversion can fail to happen degrades to uploading the
 * source unchanged, because a missing codec is not a reason to lose the evidence.
 *
 * Nothing here is ever deleted. The pipeline owns `.easy-cast/tmp/` and clears it
 * in a `finally`, including on the failure path — a module that removed its own
 * output would race the uploader that was handed the path.
 */

export interface ConversionProfile {
  readonly id: string;
  readonly args: readonly string[];
}

export type Degradation = 'ffmpeg-missing' | 'ffmpeg-failed' | 'disabled-by-flag';

export interface ConversionResult {
  /**
   * The converted file when `converted` is true, and the source path otherwise.
   * A degraded run still uploads the captured bytes, never a re-read of this path
   * (D16′) — the path is here so the caller can name the file, not re-open it.
   */
  readonly path: string;
  readonly converted: boolean;
  /**
   * What was applied, never what was asked for. Recording the requested profile
   * after a degraded run was a real bug: the digest named WebM bytes under the
   * mp4 profile's id, so the next run on a machine with ffmpeg reused the WebM
   * URL where mp4 was intended — and an upload cannot be withdrawn.
   */
  readonly effectiveProfileId: string;
  readonly degraded?: Degradation;
  /** Returned rather than printed: stdout carries one JSON object and nothing else. */
  readonly warning?: string;
}

export interface ConvertDeps {
  readonly spawn: typeof spawnScrubbed;
  /** The pipeline owns this directory's lifecycle, so it also gets to name it. */
  readonly tmpDir?: string;
}

/**
 * D12: any semantic change to these arguments is a different profile and has to
 * take a different id — the id is half of the ledger's digest, and reusing it
 * across two meanings makes an already-uploaded asset answer for both.
 */
export const H264_PROFILE: ConversionProfile = {
  id: 'h264-crf30-faststart-noaudio-stripmeta',
  args: [
    '-c:v',
    'libx264',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    '-map_metadata',
    '-1',
  ],
};

/** The id for bytes that went up exactly as they were found. */
export const NO_PROFILE_ID = 'none';

const DEFAULT_TMP_DIR = join('.easy-cast', 'tmp');

const FFMPEG = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

/**
 * `allowEnv: []` leaves the child with no PATH of its own, so a bare `ffmpeg`
 * would resolve only through libc's `/bin:/usr/bin` fallback. On a Homebrew or
 * nix install that fails as `ffmpeg-missing` while ffmpeg is sitting right
 * there — and the run silently uploads WebM where mp4 was intended. The lookup
 * therefore happens here, in the parent, against the parent's own PATH.
 */
export function resolveFfmpeg(): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, FFMPEG);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable by us; keep walking the PATH.
    }
  }
  return undefined;
}

function degrade(
  input: SourceSnapshot,
  ceilingBytes: number,
  degraded: Degradation,
  warning: string,
): ConversionResult {
  // The one case where carrying on is pointless: shrinking the file is what
  // conversion would have done, and it did not run. Everywhere else degradation
  // is soft — a warning and the original bytes beat no evidence at all.
  if (input.byteLength > ceilingBytes) {
    throw badArgs(
      `${input.path} is ${input.byteLength} bytes, above the ${ceilingBytes}-byte ceiling, and conversion did not run (${degraded}).`,
      { degraded, byteLength: input.byteLength, ceilingBytes },
    );
  }
  return {
    path: input.path,
    converted: false,
    effectiveProfileId: NO_PROFILE_ID,
    degraded,
    warning,
  };
}

/** `profile === null` is `--no-convert`: the caller asked for nothing to happen. */
export async function convert(
  input: SourceSnapshot,
  profile: ConversionProfile | null,
  ceilingBytes: number,
  deps: ConvertDeps,
): Promise<ConversionResult> {
  if (profile === null) {
    return degrade(
      input,
      ceilingBytes,
      'disabled-by-flag',
      '--no-convert was given, so the source is uploaded unchanged.',
    );
  }

  const ffmpeg = resolveFfmpeg();
  if (ffmpeg === undefined) {
    return degrade(
      input,
      ceilingBytes,
      'ffmpeg-missing',
      'ffmpeg was not found on PATH, so the source is uploaded unchanged; install ffmpeg for mp4/h264, which plays in every browser.',
    );
  }

  const tmpDir = deps.tmpDir ?? DEFAULT_TMP_DIR;
  mkdirSync(tmpDir, { recursive: true });
  const stem = computeSourceHash(input).slice(0, 16);
  const stagedSource = join(tmpDir, `${stem}.src`);
  const output = join(tmpDir, `${stem}.mp4`);

  // D16′: ffmpeg reads the bytes that were captured, not the path a second time.
  // A file rewritten between capture and conversion would otherwise produce an
  // mp4 that the digest — computed over the captured bytes — does not name.
  writeFileSync(stagedSource, input.bytes);

  const result = await deps.spawn(
    ffmpeg,
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', stagedSource, ...profile.args, output],
    // Empty on purpose, and this runs before the upload token is ever resolved:
    // a child with no environment cannot inherit a secret even in principle.
    { allowEnv: [] },
  );

  // Exit 0 is not proof of an output file, and handing the uploader a path to
  // nothing would turn a soft degradation into a crash further downstream.
  const produced = existsSync(output) ? statSync(output).size : 0;
  if (result.exitCode !== 0 || produced === 0) {
    return degrade(
      input,
      ceilingBytes,
      'ffmpeg-failed',
      `ffmpeg exited ${result.exitCode}: ${result.stderr.trim() || 'no output file was produced'}`,
    );
  }

  return { path: output, converted: true, effectiveProfileId: profile.id };
}
