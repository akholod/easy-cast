import { badArgs } from './errors.js';

export type Command = 'attach' | 'upload' | 'recover' | 'help' | 'version';

export interface ParsedArgs {
  readonly command: Command;
  readonly files: readonly string[];
  readonly to?: string;
  readonly repo?: string;
  readonly caption?: string;
  readonly key?: string;
  readonly confirmPlan?: string;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly noConvert: boolean;
  readonly allowPublic: boolean;
}

const VALUE_FLAGS = new Set(['--to', '--repo', '--caption', '--key']);
const BOOL_FLAGS = new Set(['--dry-run', '--json', '--no-convert', '--allow-public']);

/**
 * Hand-rolled rather than pulled from a library: the surface is small, and every
 * dependency in a tool that handles a bearer token is one more thing to trust.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv;
  if (rawCommand === undefined || rawCommand === 'help' || rawCommand === '--help' || rawCommand === '-h') {
    return blank('help');
  }
  if (rawCommand === 'version' || rawCommand === '--version' || rawCommand === '-v') {
    return blank('version');
  }
  if (rawCommand !== 'attach' && rawCommand !== 'upload' && rawCommand !== 'recover') {
    throw badArgs(`unknown command ${JSON.stringify(rawCommand)}; expected attach, upload or recover`);
  }

  const files: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];

    if (argument.startsWith('--confirm-plan=')) {
      values.set('--confirm-plan', argument.slice('--confirm-plan='.length));
      continue;
    }
    if (argument === '--confirm-plan') {
      throw badArgs('--confirm-plan takes its token inline, as --confirm-plan=<token>');
    }
    if (BOOL_FLAGS.has(argument)) {
      flags.add(argument);
      continue;
    }
    if (VALUE_FLAGS.has(argument)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) throw badArgs(`${argument} requires a value`);
      if (values.has(argument)) throw badArgs(`${argument} was given twice`);
      values.set(argument, value);
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw badArgs(`unknown flag ${JSON.stringify(argument)}`);
    files.push(argument);
  }

  const parsed: ParsedArgs = {
    command: rawCommand,
    files,
    to: values.get('--to'),
    repo: values.get('--repo'),
    caption: values.get('--caption'),
    key: values.get('--key'),
    confirmPlan: values.get('--confirm-plan'),
    dryRun: flags.has('--dry-run'),
    json: flags.has('--json'),
    noConvert: flags.has('--no-convert'),
    allowPublic: flags.has('--allow-public'),
  };

  if (rawCommand === 'attach') {
    if (parsed.to === undefined) throw badArgs('attach needs --to pr, --to pr:<n> or --to issue:<n>');
    if (files.length === 0) throw badArgs('attach needs at least one file');
  }
  if (rawCommand === 'upload') {
    if (files.length === 0) throw badArgs('upload needs at least one file');
    // Refused rather than ignored. Each of these would look like it was doing
    // something — and `--allow-public` would look like it was protecting
    // something — on a command that posts nowhere.
    if (parsed.to !== undefined) {
      throw badArgs('upload posts nothing, so it takes no --to. Use attach to put a file on an issue or PR.');
    }
    if (parsed.caption !== undefined) {
      throw badArgs('upload writes no comment, so a --caption would go nowhere.');
    }
    if (parsed.key !== undefined) {
      throw badArgs('upload writes no comment, so there is no comment for --key to address.');
    }
    if (parsed.allowPublic) {
      throw badArgs(
        'upload has no public-repository gate, so --allow-public would protect nothing: an asset is ' +
          'readable by whoever can see the URL you paste, not by the repository it was uploaded against.',
      );
    }
  }
  if (rawCommand === 'recover' && files.length > 0) throw badArgs('recover takes no files');

  return parsed;
}

const blank = (command: Command): ParsedArgs => ({
  command,
  files: [],
  dryRun: false,
  json: false,
  noConvert: false,
  allowPublic: false,
});

export const HELP = `easy-cast — attach visual evidence to a GitHub issue or pull request

  easy-cast attach <file...> --to pr | pr:<n> | issue:<n>
  easy-cast upload <file...> [--repo owner/name]
  easy-cast recover

Flags
  --to <target>        attach only: pr (from the current branch), pr:<n>, issue:<n>
  --repo owner/name    override the repository inferred from the git remote
  --caption <text>     attach only: a line above the attachments
  --key <key>          attach only: address a specific comment; defaults to a hash of the files
  --dry-run            print the plan and a --confirm-plan token; changes nothing
  --json               emit exactly one JSON object, whatever the outcome
  --no-convert         upload video as-is instead of converting it to mp4
  --allow-public       attach only: consent to uploading into a public repository
  --confirm-plan=<t>   the token printed by a preceding --dry-run

attach posts the files into a comment it owns, and a repeat run reuses what it
already uploaded. upload prints URLs and keeps no record at all: no journal, no
ledger, no deduplication, and no public-repository gate — an asset is readable by
whoever can see the URL you paste, not by the repository it was uploaded against.

An uploaded attachment can never be deleted. --confirm-plan guarantees that what
is uploaded matches the plan the token was computed for; it does not prove anyone
looked at that plan, and it cannot.
`;
