#!/usr/bin/env node
import { resolve } from 'node:path';
import { HELP, parseArgs, type ParsedArgs } from './cli-args.js';
import { targetNotFound, toEasyCastError } from './errors.js';
import { buildOutput, renderJson, type CliJsonOutput } from './output.js';
import { redact, redactValues } from './secret/redact.js';
import { createJournal } from './journal.js';
import { recover } from './recover.js';
import { runAttach } from './pipeline.js';
import { createUploadPort } from './upload/upload.js';
import { createGhApi } from './github/gh-cli.js';
import { spawnScrubbed } from './secret/spawn.js';
import { assertSameIdentity, ghAllowEnv, resolveToken } from './secret/token.js';
import { readGit, currentBranch } from './target/git-reader.js';
import { resolveTarget } from './target/resolve.js';
import { parseTarget } from './target/parse.js';
import { convert, resolveFfmpeg, H264_PROFILE } from './media/convert.js';

export const CLI_VERSION = '0.1.0';

const STATE_DIR = '.easy-cast';

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCli(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  let parsed: ParsedArgs | undefined;
  try {
    parsed = parseArgs(argv);

    if (parsed.command === 'help') {
      io.stdout(HELP);
      return 0;
    }
    if (parsed.command === 'version') {
      io.stdout(`${CLI_VERSION}\n`);
      return 0;
    }

    const output = await execute(parsed, io);
    emit(output, parsed.json, io);
    return output.exitCode;
  } catch (thrown) {
    // Nothing escapes as a stack trace: with --json the contract is exactly one
    // JSON object on stdout no matter how the run ended, including a bug in here.
    const error = toEasyCastError(thrown);
    const output = buildOutput({
      command: parsed?.command === 'upload' ? 'upload' : parsed?.command === 'recover' ? 'recover' : 'attach',
      reason: error.reason,
      message: redact(error.message),
      ...(error.reason === 'plan_mismatch' && isPlanContext(error.context)
        ? { planContext: { changed: error.context.changed, expected: error.context.expected } }
        : {}),
      ...(typeof error.context.branch === 'string' ? { branch: error.context.branch } : {}),
      // Exit 3 means the agent has to ask a person something. It can only phrase a
      // useful question if it knows which repository was looked at and how that
      // repository was chosen.
      ...(typeof error.context.owner === 'string' && typeof error.context.repo === 'string'
        ? {
            target: {
              owner: error.context.owner,
              repo: error.context.repo,
              visibility: 'unknown',
              repoSource:
                (error.context.repoSource as 'flag' | 'origin' | 'sole-remote' | undefined) ?? 'origin',
              ...(typeof error.context.number === 'number' ? { number: error.context.number } : {}),
            },
          }
        : {}),
    });
    // Read straight from argv rather than from the parse result: the parse is
    // exactly what failed here, and the one-JSON-object guarantee has to hold for
    // the earliest failures too — those are the ones a machine caller hits first.
    emit(output, parsed?.json ?? argv.includes('--json'), io);
    return output.exitCode;
  }
}

const isPlanContext = (
  context: Readonly<Record<string, unknown>>,
): context is { changed: string[]; expected: string } =>
  Array.isArray(context.changed) && typeof context.expected === 'string';

/**
 * The single output boundary, and the only place that writes to stdout.
 *
 * Redaction happens here rather than at each site that builds a string: a file
 * name, an anomaly detail or a `gh` error can all carry a token-shaped value, and
 * relying on every producer to remember is how one of them eventually forgets.
 */
function emit(output: CliJsonOutput, json: boolean, io: Io): void {
  // JSON is redacted field by field BEFORE serialization. Redacting the finished
  // document could consume an escaped quote inside a string and produce output
  // that no longer parses — breaking the one-valid-object promise precisely when
  // something has already gone wrong.
  io.stdout(json ? `${renderJson(redactValues(output))}\n` : `${redact(human(output))}\n`);
}

function human(output: CliJsonOutput): string {
  const lines: string[] = [];
  if (output.target) {
    const { owner, repo, kind, number, repoSource } = output.target;
    const where = number === undefined ? `${owner}/${repo}` : `${owner}/${repo} ${kind}#${number}`;
    // Where the repository came from is printed on every inferred run: the working
    // directory decides it, and a wrong directory is an upload that cannot be undone.
    lines.push(repoSource === 'flag' ? where : `${where}  (repository from git remote: ${repoSource})`);
  }
  for (const file of output.uploaded) {
    const size = file.sizeBytes === undefined ? '' : `  ${kb(file.sizeBytes)}`;
    const warn = file.sizeVerdict === 'warn' ? '  (over GitHub’s documented threshold)' : '';
    const action = file.plannedAction ? `${file.plannedAction.padEnd(13)}` : `${file.status.padEnd(13)}`;
    lines.push(`  ${action} ${file.name}${size}${warn}${file.url ? `  ${file.url}` : ''}`);
  }
  if (output.comment) lines.push(output.comment.url);

  // The human-readable plan. Someone has to own rendering it, or --confirm-plan
  // degenerates into two automated calls with nothing shown in between.
  if (output.dryRun) {
    if (output.environment) {
      lines.push(
        output.environment.ffmpegAvailable
          ? '  video will be converted to mp4 (ffmpeg found)'
          : '  ffmpeg not found: video would be uploaded as-is, and may not play in Safari',
      );
    }
    lines.push(
      '',
      'Nothing has been uploaded. Review the files above, then re-run with:',
      `  --confirm-plan=${output.planToken}`,
      '',
      'An uploaded attachment can never be deleted. This token proves the upload will',
      'match this plan; it does not prove anyone read it.',
    );
  }
  for (const anomaly of output.anomalies ?? []) lines.push(`  ! ${anomaly.code}: ${anomaly.detail}`);
  if (output.recovery && !output.recovery.commentLedgerPersisted && output.recovery.pending.length) {
    lines.push(
      `  ! ${output.recovery.pending.length} uploaded file(s) are recorded only in ${output.recovery.journalPath}.`,
      '    Re-run the same command to write them into the comment.',
    );
  }
  for (const note of output.notes ?? []) lines.push('', note);
  if (output.message) lines.push(output.message);
  return lines.join('\n');
}

const kb = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

async function execute(parsed: ParsedArgs, io: Io): Promise<CliJsonOutput> {
  const cwd = process.cwd();
  const journal = createJournal(resolve(cwd, STATE_DIR));

  if (parsed.command === 'recover') return recover(journal);

  if (parsed.command === 'upload') {
    // `upload` is not wired up until the endpoint's wire format is established;
    // claiming otherwise would be worse than saying so.
    return buildOutput({
      command: 'upload',
      reason: 'endpoint_unavailable',
      message: 'upload is not available until the endpoint protocol is established (stage 0 pending).',
    });
  }

  const source = await resolveToken();
  const api = createGhApi({ spawn: spawnScrubbed, allowEnv: ghAllowEnv(source.source) });
  // With an explicit --repo there is nothing to infer, so git is not consulted at
  // all — the point of the flag is to take the working directory out of the
  // decision entirely, not merely to override its answer.
  const git = parsed.repo
    ? { topLevel: () => undefined, remotes: () => [] }
    : await readGit(cwd);

  const target = await resolveTarget(parseTarget(parsed.to!), parsed.repo, {
    api,
    git,
    cwd,
    currentBranch: () => currentBranch(cwd),
  });

  if (target.repoSource !== 'flag') {
    io.stderr(
      redact(
        `easy-cast: repository ${target.owner}/${target.repo} inferred from git remote (${target.repoSource})\n`,
      ),
    );
  }

  const tmp: string[] = [];
  return runAttach(
    {
      command: 'attach',
      files: parsed.files,
      caption: parsed.caption,
      key: parsed.key,
      dryRun: parsed.dryRun,
      noConvert: parsed.noConvert,
      allowPublic: parsed.allowPublic,
      confirmPlan: parsed.confirmPlan,
    },
    {
      api,
      journal,
      uploads: createUploadPort(),
      resolveTarget: async () => target,
      uploadTarget: async () => {
        const info = await api.getRepo(target.owner, target.repo);
        if (!info) {
          throw targetNotFound(`${target.owner}/${target.repo} is no longer visible to this token.`, {
            owner: target.owner,
            repo: target.repo,
          });
        }
        return { owner: target.owner, repo: target.repo, repositoryId: info.id };
      },
      convert: async (snapshot, noConvert) => {
        const result = await convert(snapshot, noConvert ? null : H264_PROFILE, Number.MAX_SAFE_INTEGER, {
          spawn: spawnScrubbed,
          tmpDir: resolve(cwd, STATE_DIR, 'tmp'),
        });
        if (result.converted) tmp.push(result.path);
        return result;
      },
      resolveUploadToken: async () => ({ token: source.token, login: await api.getViewerLogin() }),
      assertIdentity: (uploadLogin, commentLogin) =>
        assertSameIdentity(uploadLogin, commentLogin, source.source),
      now: () => new Date().toISOString(),
      tmpPaths: () => tmp,
      ffmpegAvailable: () => resolveFfmpeg() !== undefined,
    },
  );
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('cli.js')) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${redact(String(error))}\n`);
      process.exitCode = 1;
    },
  );
}
