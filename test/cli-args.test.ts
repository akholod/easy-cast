import { describe, expect, it } from 'vitest';
import { HELP, parseArgs } from '../src/cli-args.js';
import { EasyCastError } from '../src/errors.js';

const refuses = (argv: string[], match?: RegExp) => {
  try {
    parseArgs(argv);
    expect.unreachable(`expected ${argv.join(' ')} to be refused`);
  } catch (error) {
    expect(error).toBeInstanceOf(EasyCastError);
    expect((error as EasyCastError).outcome.exitCode).toBe(2);
    if (match) expect((error as EasyCastError).message).toMatch(match);
  }
};

describe('commands', () => {
  it('parses attach with a target and files', () => {
    expect(parseArgs(['attach', 'a.png', 'b.png', '--to', 'pr:42'])).toMatchObject({
      command: 'attach',
      files: ['a.png', 'b.png'],
      to: 'pr:42',
    });
  });

  it('parses upload with an explicit repository', () => {
    expect(parseArgs(['upload', 'a.png', '--repo', 'akholod/easy-cast'])).toMatchObject({
      command: 'upload',
      repo: 'akholod/easy-cast',
    });
  });

  it('parses recover with nothing else', () => {
    expect(parseArgs(['recover'])).toMatchObject({ command: 'recover', files: [] });
  });

  it.each([[[]], [['help']], [['--help']], [['-h']]])('treats %j as a request for help', (argv) => {
    expect(parseArgs(argv).command).toBe('help');
  });

  it('refuses an unknown command rather than guessing', () => {
    refuses(['publish', 'a.png'], /unknown command/);
  });
});

describe('flags', () => {
  it('reads every boolean flag', () => {
    expect(
      parseArgs(['attach', 'a.png', '--to', 'pr', '--dry-run', '--json', '--no-convert', '--allow-public']),
    ).toMatchObject({ dryRun: true, json: true, noConvert: true, allowPublic: true });
  });

  it('reads the plan token inline', () => {
    expect(parseArgs(['attach', 'a.png', '--to', 'pr', '--confirm-plan=v1.abc']).confirmPlan).toBe('v1.abc');
  });

  // Separated form would put the token in its own argv slot for no benefit; the
  // inline form keeps the error message honest about the shape it expects.
  it('refuses a separated --confirm-plan', () => {
    refuses(['attach', 'a.png', '--to', 'pr', '--confirm-plan', 'v1.abc'], /inline/);
  });

  it('refuses a value flag with no value', () => {
    refuses(['attach', 'a.png', '--to'], /requires a value/);
  });

  it('refuses the same value flag twice', () => {
    refuses(['attach', 'a.png', '--to', 'pr', '--to', 'issue:1'], /twice/);
  });

  it('refuses an unknown flag rather than treating it as a file name', () => {
    refuses(['attach', 'a.png', '--to', 'pr', '--force'], /unknown flag/);
  });
});

describe('required arguments', () => {
  it('refuses attach with no target', () => refuses(['attach', 'a.png'], /--to/));
  it('refuses attach with no files', () => refuses(['attach', '--to', 'pr'], /at least one file/));
  it('refuses upload with no files', () => refuses(['upload'], /at least one file/));
  it('refuses recover with files', () => refuses(['recover', 'a.png'], /takes no files/));
});

describe('help text', () => {
  // The limit of the mechanism is stated where someone will actually read it,
  // not only in the docs.
  it('says plainly that the plan token does not prove anyone looked', () => {
    expect(HELP).toMatch(/can never be deleted/);
    expect(HELP).toMatch(/does not prove anyone\s+looked/);
  });

  it('lists all three commands', () => {
    for (const command of ['attach', 'upload', 'recover']) expect(HELP).toContain(command);
  });
});
