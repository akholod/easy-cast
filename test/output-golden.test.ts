import { describe, expect, it } from 'vitest';
import { OUTCOMES } from '../src/exit-codes.js';
import { buildOutput, renderJson, SCHEMA } from '../src/output.js';
import { runCli, type Io } from '../src/cli.js';

/**
 * The agent-facing contract. Every `(exitCode, reason)` pair the tool can produce
 * gets an object here, so a new reason cannot be added without a golden shape to
 * go with it.
 */
describe.each(OUTCOMES.map((spec) => [spec.reason, spec] as const))('golden output for %s', (reason, spec) => {
  const output = buildOutput({ command: 'attach', reason });

  it('carries the schema, the reason and a decidable next action', () => {
    expect(output.schema).toBe(SCHEMA);
    expect(output.reason).toBe(reason);
    expect(output.exitCode).toBe(spec.exitCode);
    expect(output.nextAction).toBe(spec.nextAction);
    expect(output.ok).toBe(spec.exitCode === 0);
  });

  it('always discloses that an upload cannot be undone', () => {
    expect(output.uploadsAreIrreversible).toBe(true);
  });

  it('serialises to a single valid JSON object', () => {
    const text = renderJson(output);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text.trimStart().startsWith('{')).toBe(true);
  });

  it('never invites a retry while the remote state is unknown', () => {
    if (output.state === 'unknown') expect(output.retryable).toBe(false);
  });

  // There is no override for `retryable`: the table is the only thing that sets
  // it, so no caller can report a blocked run that also claims to be repeatable.
  it('takes retryable from the table and nowhere else', () => {
    expect(output.retryable).toBe(spec.retryable);
    expect(output.retryable === true).toBe(output.nextAction === 'retry');
  });
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  return { io, out: () => out.join(''), err: () => err.join('') };
};

describe('the CLI never breaks the one-object rule', () => {
  it('emits a single JSON object for a bad command line', async () => {
    const sink = capture();
    const code = await runCli(['attach', 'a.png', '--nonsense', '--json'], sink.io);

    expect(code).toBe(2);
    const parsed = JSON.parse(sink.out());
    expect(parsed).toMatchObject({ schema: SCHEMA, exitCode: 2, nextAction: 'fix-args' });
  });

  it('emits a single JSON object when the command itself is unknown', async () => {
    const sink = capture();
    expect(await runCli(['publish', '--json'], sink.io)).toBe(2);
    expect(() => JSON.parse(sink.out())).not.toThrow();
  });

  it('prints help and succeeds when asked for nothing', async () => {
    const sink = capture();
    expect(await runCli([], sink.io)).toBe(0);
    expect(sink.out()).toContain('easy-cast attach');
  });

  it('prints the version', async () => {
    const sink = capture();
    expect(await runCli(['version'], sink.io)).toBe(0);
    expect(sink.out().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Redacting the finished document can eat an escaped quote inside a string and
  // leave output that no longer parses — breaking the promise exactly when
  // something has already gone wrong. Redaction happens per value instead.
  it('stays valid JSON when a redacted value contains an escaped quote', async () => {
    const sink = capture();
    await runCli(['attach', 'a"b\\"c Authorization: Bearer abc"tail.png', '--to', 'nonsense', '--json'], sink.io);

    const text = sink.out();
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text).schema).toBe(SCHEMA);
  });

  it('keeps a token out of stdout even when it arrives inside a file name', async () => {
    const sink = capture();
    await runCli(['attach', 'ghp_FAKETOKENFAKETOKENFAKETOKENFAKE0123.png', '--to', 'bogus:1', '--json'], sink.io);
    expect(sink.out()).not.toContain('ghp_FAKETOKENFAKETOKEN');
  });

  // `upload` used to answer `endpoint_unavailable` unconditionally, and this test
  // pinned that. It is wired now, so what is pinned instead is the boundary that
  // still holds without touching the network: a flag that would mean nothing on a
  // command which posts nowhere is refused rather than quietly ignored.
  it.each([
    ['--to', ['upload', 'a.png', '--to', 'pr', '--json']],
    ['--caption', ['upload', 'a.png', '--caption', 'hi', '--json']],
    ['--key', ['upload', 'a.png', '--key', 'k', '--json']],
    ['--allow-public', ['upload', 'a.png', '--allow-public', '--json']],
  ])('refuses %s on upload instead of ignoring it', async (_flag, argv) => {
    const sink = capture();
    const code = await runCli(argv, sink.io);

    expect(code).toBe(2);
    expect(JSON.parse(sink.out())).toMatchObject({
      command: 'upload',
      reason: 'bad_args',
      nextAction: 'fix-args',
    });
  });

  it('says why --allow-public is refused rather than just that it is', async () => {
    const sink = capture();
    await runCli(['upload', 'a.png', '--allow-public', '--json'], sink.io);
    expect(JSON.parse(sink.out()).message).toContain('no public-repository gate');
  });

  // The parse is what failed, so there is no ParsedArgs to read the command from.
  // Falling back to `attach` told a machine caller its `recover` call was an
  // `attach` — a wrong field in the one object the contract promises.
  it('reports the command that was actually invoked even when the parse failed', async () => {
    const sink = capture();
    expect(await runCli(['recover', 'a.png', '--json'], sink.io)).toBe(2);
    expect(JSON.parse(sink.out())).toMatchObject({ command: 'recover', reason: 'bad_args' });
  });
});
