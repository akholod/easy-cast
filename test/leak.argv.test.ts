import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn as unscrubbedSpawn } from 'node:child_process';
import { spawnScrubbed } from '../src/secret/spawn.js';
import { ghAllowEnv } from '../src/secret/token.js';
import { redact } from '../src/secret/redact.js';

/**
 * The blocking gate: a real child process, a real token shape, and the four
 * places it could escape to — argv, stdout, stderr and the child's environment.
 */

const FAKE = 'ghp_FAKETOKENFAKETOKENFAKETOKENFAKE0123';

const REPORT_SELF = 'process.stdout.write(JSON.stringify({ argv: process.argv, env: process.env }))';

interface ChildReport {
  readonly argv: string[];
  readonly env: Record<string, string>;
}

const observe = async (allowEnv: readonly string[]) => {
  const result = await spawnScrubbed(process.execPath, ['-e', REPORT_SELF], { allowEnv });
  expect(result.exitCode).toBe(0);
  return { result, report: JSON.parse(result.stdout) as ChildReport };
};

const original = { ...process.env };
beforeEach(() => {
  process.env.GH_TOKEN = FAKE;
  process.env.GITHUB_TOKEN = FAKE;
});
afterEach(() => {
  process.env = { ...original };
});

describe('a token in the environment reaches no child that was not told to receive it', () => {
  it('appears in neither argv, stdout, stderr nor the environment of the child', async () => {
    const { result, report } = await observe(ghAllowEnv('gh'));
    expect(report.argv.join(' ')).not.toContain(FAKE);
    expect(Object.values(report.env)).not.toContain(FAKE);
    expect(result.stdout).not.toContain(FAKE);
    expect(result.stderr).not.toContain(FAKE);
  });

  it('would have been visible without the scrubbing, so the check is not vacuous', async () => {
    const inherited = await new Promise<string>((resolve) => {
      const child = unscrubbedSpawn(process.execPath, ['-e', REPORT_SELF], { env: process.env });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.on('close', () => resolve(stdout));
    });
    expect(inherited).toContain(FAKE);
  });
});

describe('gh runs under the identity that uploads (D13)', () => {
  it('never sees GITHUB_TOKEN, whichever token is the source', async () => {
    for (const source of ['gh', 'GH_TOKEN'] as const) {
      const { report } = await observe(ghAllowEnv(source));
      expect(report.env.GITHUB_TOKEN).toBeUndefined();
    }
  });

  it('receives GH_TOKEN when GH_TOKEN is the upload token', async () => {
    const { report } = await observe(ghAllowEnv('GH_TOKEN'));
    expect(report.env.GH_TOKEN).toBe(FAKE);
  });

  it('does not receive GH_TOKEN when the token came from gh itself', async () => {
    const { report } = await observe(ghAllowEnv('gh'));
    expect(report.env.GH_TOKEN).toBeUndefined();
  });
});

describe('ffmpeg-shaped calls get nothing at all', () => {
  it('runs with an empty environment under allowEnv []', async () => {
    const { report } = await observe([]);
    expect(report.env).toEqual({});
  });
});

describe('a token never survives the output path', () => {
  it('is gone from JSON output and from a debug line', () => {
    const json = JSON.stringify({ token: FAKE, header: `Authorization: Bearer ${FAKE}` });
    expect(redact(json)).not.toContain(FAKE);
    expect(redact(`debug: gh auth token -> ${FAKE}`)).not.toContain(FAKE);
  });
});
