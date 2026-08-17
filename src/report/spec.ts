import { badArgs } from '../errors.js';

/**
 * A report is several artifacts arranged into one comment, instead of a flat
 * stack of images under a single caption.
 *
 * It is a **file the caller writes**, not a directory the tool sweeps. That is
 * the whole safety argument for iteration 2: every path a report uploads was
 * named deliberately, in a document somebody could read first. `harvest` exists
 * to make writing that document cheap, and it uploads nothing — see
 * docs/decisions/024-reports-are-declared-not-swept.md.
 *
 * Unknown versions are refused rather than interpreted (D19): a spec from a
 * later format might mean something this code would get wrong, and getting it
 * wrong here posts the wrong thing permanently.
 */

export const REPORT_SPEC_VERSION = 1;

export interface ReportArtifact {
  readonly path: string;
  /** What this frame shows, and why it matters. Becomes the alt text too. */
  readonly label?: string;
}

export interface ReportComparison {
  readonly before: ReportArtifact;
  readonly after: ReportArtifact;
}

export interface ReportSection {
  readonly heading?: string;
  readonly text?: string;
  readonly artifacts?: readonly ReportArtifact[];
  /** Rendered side by side, which is the only arrangement a reviewer can compare. */
  readonly compare?: ReportComparison;
  /** Folded behind a <details>. Anything past the first point belongs here. */
  readonly collapsed?: boolean;
}

export interface ReportSpec {
  readonly version: number;
  readonly title?: string;
  readonly sections: readonly ReportSection[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asOptionalString = (value: unknown, where: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badArgs(`${where} must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

function parseArtifact(value: unknown, where: string): ReportArtifact {
  if (!isRecord(value)) throw badArgs(`${where} must be an object with a path`);
  const path = value.path;
  if (typeof path !== 'string' || path.trim() === '') {
    throw badArgs(`${where}.path must be a non-empty string`);
  }
  const label = asOptionalString(value.label, `${where}.label`);
  return label === undefined ? { path: path.trim() } : { path: path.trim(), label };
}

function parseSection(value: unknown, where: string): ReportSection {
  if (!isRecord(value)) throw badArgs(`${where} must be an object`);

  const artifactsValue = value.artifacts;
  if (artifactsValue !== undefined && !Array.isArray(artifactsValue)) {
    throw badArgs(`${where}.artifacts must be an array`);
  }
  const artifacts = (artifactsValue ?? []).map((item, index) =>
    parseArtifact(item, `${where}.artifacts[${index}]`),
  );

  let compare: ReportComparison | undefined;
  if (value.compare !== undefined) {
    if (!isRecord(value.compare)) throw badArgs(`${where}.compare must be an object`);
    compare = {
      before: parseArtifact(value.compare.before, `${where}.compare.before`),
      after: parseArtifact(value.compare.after, `${where}.compare.after`),
    };
  }

  if (value.collapsed !== undefined && typeof value.collapsed !== 'boolean') {
    throw badArgs(`${where}.collapsed must be true or false`);
  }

  const heading = asOptionalString(value.heading, `${where}.heading`);
  const text = asOptionalString(value.text, `${where}.text`);

  // A section with nothing in it renders as a heading over empty space, which
  // reads as something having failed to load.
  if (artifacts.length === 0 && !compare && !text) {
    throw badArgs(`${where} has no text, no artifacts and no comparison — it would render as nothing`);
  }
  // A fold with no heading is a disclosure triangle labelled "Details", which
  // tells the reviewer nothing about whether it is worth opening.
  if (value.collapsed === true && heading === undefined) {
    throw badArgs(`${where} is collapsed but has no heading, so nothing would say what is inside it`);
  }

  return {
    ...(heading === undefined ? {} : { heading }),
    ...(text === undefined ? {} : { text }),
    ...(artifacts.length ? { artifacts } : {}),
    ...(compare ? { compare } : {}),
    ...(value.collapsed === true ? { collapsed: true } : {}),
  };
}

export function parseReportSpec(source: string): ReportSpec {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw badArgs(`the report spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw badArgs('the report spec must be a JSON object');

  if (value.version !== REPORT_SPEC_VERSION) {
    // Quarantined, not coerced. A spec written for a later format could mean
    // something this renderer would get subtly wrong, and the result is posted.
    throw badArgs(
      `report spec version ${JSON.stringify(value.version)} is not supported (this build understands ${REPORT_SPEC_VERSION}).`,
    );
  }

  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    throw badArgs('the report spec needs at least one section');
  }

  const sections = value.sections.map((section, index) => parseSection(section, `sections[${index}]`));
  const title = asOptionalString(value.title, 'title');

  return { version: REPORT_SPEC_VERSION, ...(title === undefined ? {} : { title }), sections };
}

/**
 * Every path the spec names, in document order, duplicates removed by first
 * occurrence — the same rule the batch uses, so the plan, the uploads and the
 * rendering all agree on what "the files" are.
 */
export function pathsOf(spec: ReportSpec): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (artifact: ReportArtifact) => {
    if (seen.has(artifact.path)) return;
    seen.add(artifact.path);
    paths.push(artifact.path);
  };

  for (const section of spec.sections) {
    for (const artifact of section.artifacts ?? []) push(artifact);
    if (section.compare) {
      push(section.compare.before);
      push(section.compare.after);
    }
  }
  return paths;
}
