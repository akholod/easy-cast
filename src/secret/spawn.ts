import { spawn } from 'node:child_process';
import { redact } from './redact.js';

/**
 * The only module in this package that may import `node:child_process`, enforced
 * statically by `test/leak.arch.test.ts`. Every child process the tool starts
 * inherits an environment assembled here and nothing else.
 */

export interface SpawnScrubbedOptions {
  /** Names of the parent's variables the child is allowed to inherit. */
  readonly allowEnv: readonly string[];
  /**
   * Written to the child's stdin, then closed.
   *
   * This is how anything large or attacker-adjacent reaches a child — a rendered
   * comment body runs to tens of kilobytes and can contain a signed URL, and argv
   * is both size-limited and world-readable through `/proc/*​/cmdline`.
   */
  readonly stdin?: string;
}

export interface SpawnScrubbedResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * `gh auth token` prints whatever `GITHUB_TOKEN` holds when it is set, so a
 * caller that named it — even by accident — would swap the identity we resolved
 * for one that was never verified against the upload endpoint (D13).
 */
const NEVER_INHERITED = new Set(['GITHUB_TOKEN']);

/** The child never ran, so there is no exit code of its own to report. */
const NOT_EXECUTED = 127;

/** Killed by a signal: no exit code either, but it must not read as success. */
const SIGNALLED = 128;

function buildEnv(allowEnv: readonly string[]): NodeJS.ProcessEnv {
  // Built up from nothing rather than copied from `process.env` and filtered
  // down: a filter that is wrong leaks a secret, an allowlist that is wrong only
  // breaks a command. A null prototype keeps a variable named `__proto__` from
  // landing anywhere other than the environment.
  const env: NodeJS.ProcessEnv = Object.create(null);
  for (const name of allowEnv) {
    if (NEVER_INHERITED.has(name)) continue;
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export async function spawnScrubbed(
  command: string,
  args: readonly string[],
  options: SpawnScrubbedOptions,
): Promise<SpawnScrubbedResult> {
  // argv is world-readable through /proc/*/cmdline for as long as the child
  // lives, so a secret passed there leaks to every process on the machine.
  for (const value of [command, ...args]) {
    if (redact(value) !== value) {
      throw new Error('spawnScrubbed: refusing to put a secret-shaped value in argv');
    }
  }

  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      env: buildEnv(options.allowEnv),
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    if (options.stdin !== undefined) {
      // An EPIPE here means the child exited before reading; the exit code it
      // reports is the more useful answer, so this does not become the failure.
      child.stdin!.on('error', () => {});
      child.stdin!.end(options.stdin);
    }

    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
    });

    // A failure to start is reported in the return value instead of thrown: the
    // Error node raises carries `spawnargs`, and an unhandled one would print
    // the whole command line without passing through redact().
    child.on('error', (error) => {
      resolve({ stdout, stderr: redact(error.message), exitCode: NOT_EXECUTED });
    });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? SIGNALLED });
    });
  });
}
