import { afterEach, describe, expect, it } from 'vitest';
import { spawnScrubbed } from '../../src/secret/spawn.js';

const FAKE = 'ghp_FAKETOKENFAKETOKENFAKETOKENFAKE0123';

/** Printed by the child so the test can inspect the environment it really got. */
const DUMP_ENV = 'process.stdout.write(JSON.stringify(process.env))';

const node = (source: string, allowEnv: readonly string[]) =>
  spawnScrubbed(process.execPath, ['-e', source], { allowEnv });

/**
 * macOS adds `__CF_USER_TEXT_ENCODING` to every process it starts, below the
 * level anything here can reach: it appears in a child spawned with `env: {}`.
 * CI on macos-latest is what found it — it does not reproduce on Linux.
 *
 * It is dropped rather than asserted away, and by exact name rather than by
 * pattern, because the property under test is "nothing the parent holds reaches
 * the child". A variable the operating system inserts is not something the parent
 * passed, but anything else appearing here would be, and must still fail.
 */
const OS_INJECTED = new Set(['__CF_USER_TEXT_ENCODING']);

const childEnv = async (allowEnv: readonly string[]): Promise<Record<string, string>> => {
  const result = await node(DUMP_ENV, allowEnv);
  expect(result.exitCode).toBe(0);
  const env = JSON.parse(result.stdout) as Record<string, string>;
  return Object.fromEntries(Object.entries(env).filter(([name]) => !OS_INJECTED.has(name)));
};

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

describe('spawnScrubbed environment', () => {
  it('gives a child with allowEnv [] nothing the parent was holding', async () => {
    process.env.EASY_CAST_SHOULD_NOT_TRAVEL = 'secret-ish';
    expect(await childEnv([])).toEqual({});
  });

  // Guards the filter above: if OS_INJECTED ever grew into a blanket exemption,
  // this is what would notice.
  it('drops only the name the operating system inserts, nothing else', async () => {
    process.env.__CF_USER_TEXT_ENCODING_LOOKALIKE = 'x';
    const env = await childEnv(['__CF_USER_TEXT_ENCODING_LOOKALIKE']);
    expect(env).toEqual({ __CF_USER_TEXT_ENCODING_LOOKALIKE: 'x' });
  });

  it('passes only the named variables, never the rest of process.env', async () => {
    process.env.EASY_CAST_ALLOWED = 'yes';
    process.env.EASY_CAST_DENIED = 'no';
    expect(await childEnv(['EASY_CAST_ALLOWED'])).toEqual({ EASY_CAST_ALLOWED: 'yes' });
  });

  it('strikes GITHUB_TOKEN even when the caller lists it', async () => {
    process.env.GITHUB_TOKEN = FAKE;
    process.env.GH_TOKEN = FAKE;
    const env = await childEnv(['GH_TOKEN', 'GITHUB_TOKEN']);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBe(FAKE);
  });

  it('does not materialise a variable that is unset in the parent', async () => {
    delete process.env.EASY_CAST_MISSING;
    expect(await childEnv(['EASY_CAST_MISSING'])).toEqual({});
  });
});

const READ_STDIN =
  'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(s))';

describe('spawnScrubbed stdin', () => {
  // How anything large or attacker-adjacent reaches a child. A comment body runs
  // to tens of kilobytes, argv is size-limited and world-readable through /proc,
  // and a body carrying a signed URL would be refused by the argv guard below.
  it('writes the payload to the child and closes it', async () => {
    const result = await spawnScrubbed(process.execPath, ['-e', READ_STDIN], {
      allowEnv: [],
      stdin: 'body over stdin',
    });
    expect(result.stdout).toBe('body over stdin');
    expect(result.exitCode).toBe(0);
  });

  it('carries a payload that argv would have refused outright', async () => {
    const signed = 'https://example.invalid/a?jwt=eyJhbGciOiJIUzI1NiJ9.payload.signature';
    await expect(
      spawnScrubbed(process.execPath, ['-e', signed], { allowEnv: [] }),
    ).rejects.toThrow(/secret-shaped value in argv/);

    const result = await spawnScrubbed(process.execPath, ['-e', READ_STDIN], {
      allowEnv: [],
      stdin: signed,
    });
    expect(result.stdout).toBe(signed);
  });

  it('reports the child exit code rather than failing when nothing reads the input', async () => {
    const result = await spawnScrubbed(process.execPath, ['-e', 'process.exit(3)'], {
      allowEnv: [],
      stdin: 'x'.repeat(200_000),
    });
    expect(result.exitCode).toBe(3);
  });
});

describe('spawnScrubbed result', () => {
  it('captures stdout, stderr and a zero exit code', async () => {
    const result = await node('process.stdout.write("out"); process.stderr.write("err")', []);
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 });
  });

  it('reports a non-zero exit code instead of throwing', async () => {
    const result = await node('process.exit(3)', []);
    expect(result.exitCode).toBe(3);
  });

  it('reports a command that could not be started as a failure, not a rejection', async () => {
    const result = await spawnScrubbed('/nonexistent/easy-cast-not-a-binary', [], { allowEnv: [] });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe('');
  });
});

describe('spawnScrubbed argv guard', () => {
  it.each([
    ['a token', FAKE],
    ['an authorization header', `Authorization: Bearer ${FAKE}`],
    ['a signed url', 'https://objects.example.test/a?jwt=abc'],
  ])('refuses to put %s on the command line', async (_label, value) => {
    await expect(spawnScrubbed('echo', [value], { allowEnv: [] })).rejects.toThrow(/argv/);
  });

  it('passes ordinary arguments through unchanged', async () => {
    const result = await spawnScrubbed(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv.slice(1).join(","))', 'akholod/easy-cast', 'pr:42'],
      { allowEnv: [] },
    );
    expect(result.stdout).toBe('akholod/easy-cast,pr:42');
  });
});
