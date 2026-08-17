import { badArgs } from './errors.js';

export type Command =
  | 'attach'
  | 'upload'
  | 'recover'
  | 'report'
  | 'harvest'
  | 'compose'
  | 'help'
  | 'version';

export interface ParsedArgs {
  readonly command: Command;
  readonly files: readonly string[];
  readonly to?: string;
  readonly repo?: string;
  readonly caption?: string;
  readonly key?: string;
  readonly confirmPlan?: string;
  readonly spec?: string;
  readonly out?: string;
  readonly limit?: number;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly noConvert: boolean;
  readonly allowPublic: boolean;
}

const MUTATING_COMMANDS = new Set<Command>(['attach', 'upload', 'report']);

const VALUE_FLAGS = new Set(['--to', '--repo', '--caption', '--key', '--spec', '--out', '--limit']);
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
  const KNOWN: readonly Command[] = ['attach', 'upload', 'recover', 'report', 'harvest', 'compose'];
  if (!KNOWN.includes(rawCommand as Command)) {
    throw badArgs(`unknown command ${JSON.stringify(rawCommand)}; expected one of ${KNOWN.join(', ')}`);
  }
  const command = rawCommand as Exclude<Command, 'help' | 'version'>;

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

  const rawLimit = values.get('--limit');
  if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
    throw badArgs(`--limit must be a whole number; got ${JSON.stringify(rawLimit)}`);
  }

  const parsed: ParsedArgs = {
    command,
    files,
    to: values.get('--to'),
    repo: values.get('--repo'),
    caption: values.get('--caption'),
    key: values.get('--key'),
    confirmPlan: values.get('--confirm-plan'),
    spec: values.get('--spec'),
    out: values.get('--out'),
    ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
    dryRun: flags.has('--dry-run'),
    json: flags.has('--json'),
    noConvert: flags.has('--no-convert'),
    allowPublic: flags.has('--allow-public'),
  };

  // `--spec` names the document that decides what gets posted. On any other
  // command it would be silently ignored, and the caller would believe a report
  // had been composed when a flat attach had happened instead.
  if (parsed.spec !== undefined && command !== 'report' && command !== 'compose') {
    throw badArgs('--spec belongs to report and compose; attach takes the files directly.');
  }

  if (command === 'attach') {
    if (parsed.to === undefined) throw badArgs('attach needs --to pr, --to pr:<n> or --to issue:<n>');
    if (files.length === 0) throw badArgs('attach needs at least one file');
  }

  if (command === 'report') {
    if (parsed.spec === undefined) throw badArgs('report needs --spec <file>; write one with harvest.');
    if (parsed.to === undefined) throw badArgs('report needs --to pr, --to pr:<n> or --to issue:<n>');
    if (files.length > 0) {
      throw badArgs('report takes its files from the spec, not from the command line.');
    }
  }

  if (command === 'harvest') {
    if (files.length === 0) throw badArgs('harvest needs a directory or a file to look in');
  }

  if (command === 'compose') {
    if (parsed.spec === undefined) throw badArgs('compose needs --spec <file>');
    if (files.length > 0) throw badArgs('compose takes its files from the spec, not from the command line');
  }

  // Neither reads a credential, neither touches GitHub, and neither can create
  // anything irreversible — so a plan handshake would be ceremony, and refusing
  // the flag says why rather than ignoring it.
  if (!MUTATING_COMMANDS.has(command) && parsed.confirmPlan !== undefined) {
    throw badArgs(`${command} uploads nothing, so there is no plan for --confirm-plan to confirm.`);
  }

  if (command === 'upload') {
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
  if (command === 'recover' && files.length > 0) throw badArgs('recover takes no files');

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

  easy-cast harvest <dir...> [--out spec.json]      find media, write a report spec
  easy-cast compose --spec spec.json                print the comment it would post
  easy-cast report  --spec spec.json --to pr        upload and post that report

Flags
  --to <target>        attach/report: pr (from the current branch), pr:<n>, issue:<n>
  --repo owner/name    override the repository inferred from the git remote
  --caption <text>     attach only: a line above the attachments
  --key <key>          attach/report: address a specific comment; defaults to a hash of the files
  --spec <file>        report/compose: the report spec to render
  --out <file>         harvest only: where to write the spec (default: stdout)
  --limit <n>          harvest only: refuse more than n files (default 32)
  --dry-run            print the plan and a --confirm-plan token; changes nothing
  --json               emit exactly one JSON object, whatever the outcome
  --no-convert         upload video as-is instead of converting it to mp4
  --allow-public       attach/report: consent to uploading into a public repository
  --confirm-plan=<t>   the token printed by a preceding --dry-run

A report is several artifacts arranged into one comment — headings, per-artifact
labels, before/after side by side, folds. harvest and compose upload nothing:
harvest writes a spec with the labels left blank, compose shows you the comment
that spec would produce. Only report uploads, and only against a plan token that
covers the spec as well as the files.

attach posts the files into a comment it owns, and a repeat run reuses what it
already uploaded. upload prints URLs and keeps no record at all: no journal, no
ledger, no deduplication, and no public-repository gate — an asset is readable by
whoever can see the URL you paste, not by the repository it was uploaded against.

An uploaded attachment can never be deleted. --confirm-plan guarantees that what
is uploaded matches the plan the token was computed for; it does not prove anyone
looked at that plan, and it cannot.
`;
