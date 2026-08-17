import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { badArgs } from '../errors.js';
import { classifyExtension } from '../media/mime.js';
import { buildOutput, type CliJsonOutput } from '../output.js';
import { harvestFiles, harvestSpec, serializeSpec, type HarvestOptions } from './harvest.js';
import { renderReportPreview } from './render-report.js';
import { parseReportSpec, pathsOf, type ReportSpec } from './spec.js';

/**
 * The two report commands that never touch GitHub.
 *
 * They exist so that the one command that *does* — `report` — is preceded by
 * something a person can read. `harvest` says what is there; `compose` says what
 * would be posted. Neither reads a credential, and neither can create anything
 * that cannot be deleted.
 */

/** Left in the spec by `harvest`, so a spec nobody edited is recognisable. */
export const HARVEST_PLACEHOLDER = 'REPLACE THIS';

export function readSpec(path: string): { spec: ReportSpec; specHash: string; source: string } {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw badArgs(`could not read the report spec at ${path}`);
  }
  const spec = parseReportSpec(source);
  // Hashed from the parsed form, not the file: whitespace and key order are not
  // part of what gets posted, and a re-indented spec is the same plan.
  const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  return { spec, specHash, source };
}

/**
 * Refuses a spec that still carries `harvest`'s placeholder.
 *
 * Not pedantry: the placeholder is the one mechanical sign that nobody opened
 * the files. An unedited spec posts a comment full of unlabelled screenshots
 * under the words "REPLACE THIS", permanently.
 */
export function assertEdited(spec: ReportSpec): void {
  const untouched = spec.sections.some((section) => section.text?.includes(HARVEST_PLACEHOLDER));
  if (untouched) {
    throw badArgs(
      'this spec still contains harvest\'s placeholder text, so nothing has been written about the ' +
        'artifacts yet. Describe the report and label the artifacts, then run it again.',
    );
  }
}

export function runHarvest(
  roots: readonly string[],
  options: HarvestOptions & { out?: string; base?: string } = {},
): CliJsonOutput {
  const files = harvestFiles(roots, options);
  const spec = harvestSpec(files, options.base);
  const serialized = serializeSpec(spec);

  if (options.out) {
    try {
      writeFileSync(options.out, serialized);
    } catch (error) {
      throw badArgs(
        `could not write the spec to ${options.out}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return buildOutput({
    command: 'harvest',
    reason: 'ok',
    ...(options.out ? {} : { body: serialized.trimEnd() }),
    uploaded: files.map((file) => ({
      name: file.path,
      sourceHash: '',
      digest: '',
      status: 'skipped' as const,
      plannedAction: 'would-upload' as const,
      state: 'known' as const,
      retryable: false,
      sizeBytes: file.byteLength,
    })),
    notes: [
      `${files.length} file(s) found. Nothing was uploaded and nothing can be: harvest only writes a document.`,
      'Every label came back blank on purpose. Open each file, write what it shows, and delete the ' +
        'placeholder text — a spec that still carries it is refused by report.',
      options.out
        ? `Spec written to ${options.out}. Next: easy-cast compose --spec ${options.out}`
        : 'Next: save this to a file, edit it, then easy-cast compose --spec <file>',
    ],
  });
}

export function runCompose(specPath: string): CliJsonOutput {
  const { spec } = readSpec(specPath);
  const paths = pathsOf(spec);

  const missing = paths.filter((path) => !classifyExtension(path));
  if (missing.length > 0) {
    throw badArgs(
      `the spec names ${missing.length} file(s) GitHub does not accept as attachments: ${missing.join(', ')}`,
    );
  }

  const body = renderReportPreview(spec, (path) => classifyExtension(path)!.category);

  return buildOutput({
    command: 'compose',
    reason: 'ok',
    body,
    notes: [
      'Nothing was uploaded. Every URL above is a placeholder — the real ones do not exist yet.',
      `${paths.length} artifact(s) would be uploaded by: easy-cast report --spec <file> --to <target>`,
    ],
  });
}
