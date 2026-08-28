import { badArgs } from './errors.js';

export type Command =
  | 'attach'
  | 'upload'
  | 'recover'
  | 'report'
  | 'harvest'
  | 'compose'
  | 'render'
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
  readonly outDir?: string;
  readonly limit?: number;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly noConvert: boolean;
  readonly allowPublic: boolean;
}

const MUTATING_COMMANDS = new Set<Command>(['attach', 'upload', 'report']);

/**
 * Every verb the CLI answers to, and the one list that says so.
 *
 * Exported because the surface has two other obligations that drift silently
 * otherwise: `HELP` below must name each one, and the skill that ships in the
 * npm tarball must document each one. `test/package-metadata.test.ts` asserts
 * both against this array rather than against a hand-kept copy.
 */
export const COMMAND_VERBS: readonly Command[] = [
  'attach',
  'upload',
  'recover',
  'report',
  'harvest',
  'compose',
  'render',
];

// `--out-dir` rather than reusing `--out`. `--out` names a *file* — the spec
// harvest writes — and threading a directory through the same flag is the
// overload this tool already refuses on `--to`: one argument that means "a place
// nothing can be undone from" on one command and "a place to write a document"
// on another is how a caller ends up somewhere they did not intend.
const VALUE_FLAGS = new Set([
  '--to',
  '--repo',
  '--caption',
  '--key',
  '--spec',
  '--out',
  '--out-dir',
  '--limit',
]);
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
  if (!COMMAND_VERBS.includes(rawCommand as Command)) {
    throw badArgs(
      `unknown command ${JSON.stringify(rawCommand)}; expected one of ${COMMAND_VERBS.join(', ')}`,
    );
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
    outDir: values.get('--out-dir'),
    ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
    dryRun: flags.has('--dry-run'),
    json: flags.has('--json'),
    noConvert: flags.has('--no-convert'),
    allowPublic: flags.has('--allow-public'),
  };

  // `--spec` names the document that decides what gets posted. On any other
  // command it would be silently ignored, and the caller would believe a report
  // had been composed when a flat attach had happened instead.
  if (
    parsed.spec !== undefined &&
    command !== 'report' &&
    command !== 'compose' &&
    command !== 'render'
  ) {
    throw badArgs('--spec belongs to report, compose and render; attach takes the files directly.');
  }

  // `--out-dir` is render's destination and nothing else's. Left unguarded it
  // would be accepted and ignored everywhere, which reads as "written" to a
  // caller who passed it to the wrong verb.
  if (parsed.outDir !== undefined && command !== 'render') {
    throw badArgs('--out-dir belongs to render; harvest writes a single file with --out.');
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

  if (command === 'render') {
    if (parsed.spec === undefined) throw badArgs('render needs --spec <file>; write one with harvest.');
    if (parsed.outDir === undefined) throw badArgs('render needs --out-dir <directory>');
    // Declared, not swept (D24). A directory of files is not a report, and
    // accepting one here would make the local sink the one path that publishes
    // whatever happened to be lying around.
    if (files.length > 0) {
      throw badArgs(
        'render takes its files from the spec, not from the command line. Point harvest at a ' +
          'directory to write a spec first.',
      );
    }
    // Refused rather than ignored, for the same reason `upload` refuses them:
    // each would look like it was doing something on a command that posts
    // nowhere and reads no credential.
    if (parsed.to !== undefined) {
      throw badArgs(
        'render writes a local folder, so it takes no --to. Use report --spec to put the same spec ' +
          'on an issue or PR.',
      );
    }
    if (parsed.caption !== undefined) {
      throw badArgs('render writes no comment, so a --caption would go nowhere.');
    }
    if (parsed.key !== undefined) {
      throw badArgs('render writes no comment, so there is no comment for --key to address.');
    }
    if (parsed.allowPublic) {
      throw badArgs(
        'render uploads nothing, so --allow-public would gate nothing. The folder is as public as ' +
          'wherever you copy it.',
      );
    }
  }

  // Neither reads a credential, neither touches GitHub, and neither can create
  // anything irreversible — so a plan handshake would be ceremony, and refusing
  // the flag says why rather than ignoring it.
  if (!MUTATING_COMMANDS.has(command) && parsed.confirmPlan !== undefined) {
    throw badArgs(`${command} uploads nothing, so there is no plan for --confirm-plan to confirm.`);
  }

  // Same reasoning, same set. `--dry-run` means "show me the plan and change
  // nothing", and on a command that changes nothing there is no plan and no
  // difference to show. Accepted-and-ignored is the worse answer: a caller who
  // passed it believes a preview happened.
  if (!MUTATING_COMMANDS.has(command) && parsed.dryRun) {
    throw badArgs(
      `${command} creates nothing, so --dry-run has nothing to preview. Run it: the result is the preview.`,
    );
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
  easy-cast render  --spec spec.json --out-dir dir  write that report to a local folder
  easy-cast report  --spec spec.json --to pr        upload and post that report

Flags
  --to <target>        attach/report: pr (from the current branch), pr:<n>, issue:<n>
  --repo owner/name    override the repository inferred from the git remote
  --caption <text>     attach only: a line above the attachments
  --key <key>          attach/report: address a specific comment; defaults to a hash of the files
  --spec <file>        report/compose/render: the report spec to render
  --out <file>         harvest only: where to write the spec (default: stdout)
  --out-dir <dir>      render only: the folder to write; must be empty or absent
  --limit <n>          harvest only: refuse more than n files (default 32)
  --dry-run            print the plan and a --confirm-plan token; changes nothing
  --json               emit exactly one JSON object, whatever the outcome
  --no-convert         upload video as-is instead of converting it to mp4
  --allow-public       attach/report: consent to uploading into a public repository
  --confirm-plan=<t>   the token printed by a preceding --dry-run

A report is several artifacts arranged into one comment — headings, per-artifact
labels, before/after side by side, folds. harvest, compose and render upload
nothing: harvest writes a spec with the labels left blank, compose shows you the
comment that spec would produce, and render writes that same comment to a folder
with the artifacts copied beside it. Only report uploads, and only against a plan
token that covers the spec as well as the files.

One spec, one renderer: what render writes to a folder is what report posts to a
comment, so a local-first run promotes with no re-authoring. The local review
does not carry over — report has its own plan token and its own
public-repository gate.

attach posts the files into a comment it owns, and a repeat run reuses what it
already uploaded. upload prints URLs and keeps no record at all: no journal, no
ledger, no deduplication, and no public-repository gate — an asset is readable by
whoever can see the URL you paste, not by the repository it was uploaded against.

An uploaded attachment can never be deleted. --confirm-plan guarantees that what
is uploaded matches the plan the token was computed for; it does not prove anyone
looked at that plan, and it cannot.
`;
