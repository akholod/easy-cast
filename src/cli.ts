#!/usr/bin/env node
import { resolve } from 'node:path';
import { HELP, parseArgs, type ParsedArgs } from './cli-args.js';
import { targetNotFound, toEasyCastError } from './errors.js';
import { buildOutput, renderJson, type CliJsonOutput, type CommandName } from './output.js';
import { redact, redactValues } from './secret/redact.js';
import { createJournal } from './journal.js';
import { recover } from './recover.js';
import { runAttach } from './pipeline.js';
import { runUpload } from './upload-run.js';
import { assertEdited, readSpec, runCompose, runHarvest } from './report/commands.js';
import { pathsOf } from './report/spec.js';
import { createUploadPort } from './upload/upload.js';
import type { GitHubApi } from './github/api.js';
import { createGhApi } from './github/gh-cli.js';
import { spawnScrubbed } from './secret/spawn.js';
import { assertSameIdentity, ghAllowEnv, resolveToken, type ResolvedToken } from './secret/token.js';
import { readGit, currentBranch } from './target/git-reader.js';
import { resolveRepo, type GitReader } from './target/infer-repo.js';
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
      command: commandFor(parsed, argv),
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

/**
 * Which command this object is reporting on, including when the parse is the
 * thing that failed.
 *
 * `parsed` is undefined exactly when `parseArgs` threw, and that is a common
 * case — a refused flag is a parse error. Defaulting to `attach` there told a
 * machine caller that its `upload` invocation was an `attach`, which is a wrong
 * field in the one object the contract promises. The verb is taken from argv for
 * the same reason `--json` is.
 */
function commandFor(parsed: ParsedArgs | undefined, argv: readonly string[]): CommandName {
  const command = parsed?.command ?? argv[0];
  return command === 'upload' ||
    command === 'recover' ||
    command === 'report' ||
    command === 'harvest' ||
    command === 'compose'
    ? command
    : 'attach';
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
  // The document a command produced comes first: the notes below refer to it.
  if (output.body) lines.push(output.body);
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

  // Local, non-mutating, and deliberately ahead of the credential: neither reads
  // a token, and neither should fail because the machine has none.
  if (parsed.command === 'harvest') {
    return runHarvest(parsed.files, {
      ...(parsed.out === undefined ? {} : { out: parsed.out }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    });
  }
  if (parsed.command === 'compose') return runCompose(parsed.spec!);

  const source = await resolveToken();
  const api = createGhApi({ spawn: spawnScrubbed, allowEnv: ghAllowEnv(source.source) });
  // With an explicit --repo there is nothing to infer, so git is not consulted at
  // all — the point of the flag is to take the working directory out of the
  // decision entirely, not merely to override its answer.
  const git = parsed.repo
    ? { topLevel: () => undefined, remotes: () => [] }
    : await readGit(cwd);

  if (parsed.command === 'upload') return upload(parsed, io, cwd, source, api, git);

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

  // A report is an attach whose comment body comes from a document instead of
  // from the argument list. Everything else — validation, plan, journal, ledger,
  // marker, repair — is the same path, which is why it is the same call.
  const report = parsed.command === 'report' ? readSpec(parsed.spec!) : undefined;
  if (report) assertEdited(report.spec);

  const tmp: string[] = [];
  return runAttach(
    {
      command: parsed.command === 'report' ? 'report' : 'attach',
      files: report ? pathsOf(report.spec) : parsed.files,
      caption: parsed.caption,
      key: parsed.key,
      dryRun: parsed.dryRun,
      noConvert: parsed.noConvert,
      allowPublic: parsed.allowPublic,
      confirmPlan: parsed.confirmPlan,
      ...(report ? { report: { spec: report.spec, specHash: report.specHash } } : {}),
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

/**
 * `upload` shares the credential, the `gh` client and the repository inference
 * with `attach`, and nothing else: no target to resolve, no comment to find, no
 * journal to open.
 */
async function upload(
  parsed: ParsedArgs,
  io: Io,
  cwd: string,
  source: ResolvedToken,
  api: GitHubApi,
  git: GitReader,
): Promise<CliJsonOutput> {
  const inferred = resolveRepo(parsed.repo, cwd, git);
  const info = await api.getRepo(inferred.owner, inferred.repo);
  if (!info) {
    // Disjunctive on purpose: a 404 cannot tell "no such repository" from "this
    // token cannot see it", and the upload endpoint answers the same way.
    throw targetNotFound(
      `${inferred.owner}/${inferred.repo} is not visible to this token — it either does not exist ` +
        'or the token has no access to it.',
      { owner: inferred.owner, repo: inferred.repo, repoSource: inferred.source },
    );
  }

  if (inferred.source !== 'flag') {
    io.stderr(
      redact(
        `easy-cast: repository ${inferred.owner}/${inferred.repo} inferred from git remote (${inferred.source})\n`,
      ),
    );
  }

  const tmp: string[] = [];
  return runUpload(
    {
      command: 'upload',
      files: parsed.files,
      dryRun: parsed.dryRun,
      noConvert: parsed.noConvert,
      confirmPlan: parsed.confirmPlan,
    },
    {
      uploads: createUploadPort(),
      resolveRepo: async () => ({
        owner: inferred.owner,
        repo: inferred.repo,
        repoSource: inferred.source,
        visibility: info.visibility,
        repositoryId: info.id,
        anomalies: inferred.anomalies,
      }),
      convert: async (snapshot, noConvert) => {
        const result = await convert(snapshot, noConvert ? null : H264_PROFILE, Number.MAX_SAFE_INTEGER, {
          spawn: spawnScrubbed,
          tmpDir: resolve(cwd, STATE_DIR, 'tmp'),
        });
        if (result.converted) tmp.push(result.path);
        return result;
      },
      resolveUploadToken: async () => ({ token: source.token }),
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
