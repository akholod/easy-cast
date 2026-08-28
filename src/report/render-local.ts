import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { prepare, type PreparedFile } from '../batch.js';
import { badArgs } from '../errors.js';
import { buildOutput, type CliJsonOutput } from '../output.js';
import { assertEdited, readSpec } from './commands.js';
import { renderReport, type ArtifactResolution, type ResolvedArtifact } from './render-report.js';
import { pathsOf } from './spec.js';

/**
 * The third resolution builder.
 *
 * `renderReport` is parameterised over a `path -> {url, category}` map and has
 * always had two callers: `report`, which hands it real asset URLs, and
 * `renderReportPreview`, which hands it `NOT-UPLOADED-YET:` placeholders. A local
 * folder is the third — relative paths into a sibling `assets/`. One spec, one
 * renderer, three resolutions, and there must never be a second renderer.
 *
 * The batch itself comes from `prepare()`, the same function `attach` and
 * `upload` use. That is not convenience: it is what makes the claim in ADR 025 —
 * that a locally rendered `report.md` is the document GitHub would receive —
 * true rather than approximately true. `prepare` reads each file exactly once,
 * deduplicates by content with first-occurrence-wins, and classifies the
 * canonical bytes once. Classifying each path independently here would let two
 * byte-identical files named `frame.png` and `clip.mp4` render one way locally
 * and another way in a comment.
 *
 * Nothing here can create anything irreversible. `render` writes a directory the
 * caller named and touches no network, which is why it takes no plan token and
 * refuses `--to`.
 */

const MANIFEST_VERSION = 1;
const ASSETS_DIRECTORY = 'assets';
/** Long enough that a collision is not a thing to reason about; short enough to read. */
const HASH_PREFIX_LENGTH = 12;

export interface ManifestArtifact {
  readonly sourcePaths: readonly string[];
  readonly assetPath: string;
  /**
   * The bytes the caller pointed at — `computeSourceHash`, the `--key` and
   * plan-token identity.
   *
   * Deliberately NOT `computeDigest`, which is the ledger key and is
   * `sha256(bytes):<effectiveProfileId>`. A local render applies no conversion
   * profile, so it has no profile id to name; and a `.webm` converted to mp4 on
   * its way to GitHub has different bytes anyway. Recording the ledger key here
   * would promise a reuse that cannot happen for exactly the artifact class this
   * command exists to make reviewable.
   */
  readonly sourceHash: string;
  readonly bytes: number;
  readonly category: 'image' | 'video';
}

export interface Manifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly renderedAt: string;
  readonly artifacts: readonly ManifestArtifact[];
}

/**
 * A filename that cannot break out of `assets/` and cannot break the markup that
 * references it.
 *
 * `render-report.ts` puts image URLs inside a raw `<img src="...">` for a
 * comparison table, so a quote or a bracket in a source filename would escape the
 * attribute. `basename` already removes any path, and this removes the rest.
 */
const safeName = (path: string): string =>
  basename(path).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '') || 'artifact';

const assetNameFor = (file: PreparedFile): string =>
  `${file.sourceHash.slice(0, HASH_PREFIX_LENGTH)}-${safeName(file.name)}`;

/**
 * Refuses a destination that already holds anything.
 *
 * The reversible branch is free here: the caller names another directory. That is
 * why there is no `--force` — a destructive-sounding global boolean on a tool
 * whose whole argument is "irreversibility decides defaults" would be paying a
 * real cost to avoid a non-existent one.
 *
 * A missing directory is the good case. Anything else — a permission error, a
 * path that is a file — is surfaced rather than read as "absent", because
 * treating every failure as absence is how a run reports success into a place it
 * never wrote.
 */
function assertUsableDestination(outDir: string): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(outDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw badArgs(`cannot use ${outDir} as an output directory: ${code ?? String(error)}`);
  }
  if (entries.length > 0) {
    throw badArgs(
      `${outDir} is not empty, and render will not write into a directory that already holds ` +
        'something. Name an empty or new directory.',
    );
  }
}

/** Copies the *snapshot's* bytes, never a second read of the path. */
function writeAssets(files: readonly PreparedFile[], stageDir: string): {
  resolution: ArtifactResolution;
  artifacts: ManifestArtifact[];
} {
  const assetsDir = join(stageDir, ASSETS_DIRECTORY);
  mkdirSync(assetsDir, { recursive: true });

  const resolution = new Map<string, ResolvedArtifact>();
  const artifacts: ManifestArtifact[] = [];
  const claimed = new Map<string, string>();

  for (const file of files) {
    const assetName = assetNameFor(file);
    const owner = claimed.get(assetName);
    if (owner !== undefined && owner !== file.sourceHash) {
      // Astronomically unlikely, and silently overwriting evidence is not an
      // acceptable way to find out.
      throw badArgs(`two different files would be written as assets/${assetName}; rename one of them`);
    }
    claimed.set(assetName, file.sourceHash);

    // The snapshot is the single read (D16). Re-reading the path here would open
    // a window where manifest.json describes one set of bytes and assets/ holds
    // another.
    writeFileSync(join(assetsDir, assetName), file.snapshot.bytes);

    const url = `${ASSETS_DIRECTORY}/${assetName}`;
    // Every path that resolved to these bytes, so a spec that names the same
    // content twice places both references — the same rule the ledger applies.
    for (const path of file.paths) resolution.set(path, { url, category: file.category });

    artifacts.push({
      sourcePaths: file.paths,
      assetPath: url,
      sourceHash: file.sourceHash,
      bytes: file.snapshot.byteLength,
      category: file.category,
    });
  }

  return { resolution, artifacts };
}

export function runRender(specPath: string, outDir: string): CliJsonOutput {
  const resolvedOut = resolve(outDir);
  assertUsableDestination(resolvedOut);

  const { spec, source } = readSpec(specPath);
  // The same gate `report` applies: a spec still carrying harvest's placeholder
  // is a spec nobody opened the files for, and that is true whether the
  // destination is permanent or not.
  assertEdited(spec);

  // Validates and reads the whole batch before a byte is written, so an
  // unreadable or unaccepted file leaves nothing behind at all.
  const files = prepare(pathsOf(spec));

  // Staged in a sibling and published by rename, so a failure part-way through
  // leaves the destination absent rather than half-written. A half-written
  // directory is worse than no directory: the next run refuses it as non-empty,
  // and the caller is stuck holding evidence that looks complete.
  const parent = dirname(resolvedOut);
  mkdirSync(parent, { recursive: true });
  const stageDir = mkdtempSync(join(parent, '.easy-cast-render-'));

  let artifacts: ManifestArtifact[];
  try {
    const written = writeAssets(files, stageDir);
    artifacts = written.artifacts;

    writeFileSync(join(stageDir, 'report.md'), `${renderReport(spec, written.resolution)}\n`);
    writeFileSync(join(stageDir, 'spec.json'), source);
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      renderedAt: new Date().toISOString(),
      artifacts,
    };
    writeFileSync(join(stageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    renameSync(stageDir, resolvedOut);
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }

  const reportPath = join(resolvedOut, 'report.md');
  return buildOutput({
    command: 'render',
    reason: 'ok',
    notes: [
      `Rendered to ${resolvedOut}. Nothing was uploaded and nothing can be: render writes files and ` +
        'touches no network.',
      `The comment body is ${relative(process.cwd(), reportPath) || reportPath}; the ` +
        `${artifacts.length} artifact(s) are copies under ${ASSETS_DIRECTORY}/.`,
      'To put this on GitHub instead, the same spec goes to: easy-cast report --spec <file> --to ' +
        '<target>. The local review does not carry over — that path has its own plan token and its ' +
        'own public-repository gate.',
    ],
  });
}
