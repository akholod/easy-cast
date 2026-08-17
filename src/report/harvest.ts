import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { badArgs } from '../errors.js';
import { classifyExtension } from '../media/mime.js';
import { REPORT_SPEC_VERSION, type ReportSpec } from './spec.js';

/**
 * Finds the media a run left behind and writes a report spec for it.
 *
 * **It uploads nothing, and it must never upload anything.** That is not an
 * implementation detail — it is the reason `harvest` is allowed to exist at all.
 * A command that swept a directory and posted what it found would make a bulk
 * irreversible upload one keystroke away, and would defeat the one obligation the
 * CLI cannot enforce: that somebody looked at each frame first.
 *
 * So the output is a document. The labels come back empty, deliberately: an agent
 * that fills them in has had to open each file to know what to write, and a
 * reviewer reading the spec can see at a glance which artifacts were never
 * looked at.
 */

export interface HarvestOptions {
  /** Deepest directory level to descend into. 1 means the directory itself. */
  readonly maxDepth?: number;
  /** Cap on how many files may be gathered; over it, the caller is asked to narrow. */
  readonly limit?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_LIMIT = 32;

/** Directories that never hold evidence and always hold thousands of files. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', '.easy-cast']);

export interface HarvestedFile {
  readonly path: string;
  readonly byteLength: number;
}

export function harvestFiles(roots: readonly string[], options: HarvestOptions = {}): HarvestedFile[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const found: HarvestedFile[] = [];

  for (const root of roots) {
    let stats;
    try {
      stats = statSync(root);
    } catch {
      throw badArgs(`${root} does not exist`);
    }
    if (stats.isFile()) {
      if (classifyExtension(root)) found.push({ path: root, byteLength: stats.size });
      continue;
    }
    walk(root, 1);
  }

  // Stable and predictable: the same directory yields the same spec twice, so a
  // re-harvest produces a diff a person can read rather than a reshuffle.
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (found.length > limit) {
    throw badArgs(
      `${found.length} media files found, over the ${limit}-file harvest limit. ` +
        'Narrow the directory or pass --limit — a report nobody can read is not evidence.',
    );
  }
  return found;

  function walk(directory: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // Unreadable subdirectory: skipped, not fatal.
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!classifyExtension(entry.name)) continue;
      try {
        found.push({ path: full, byteLength: statSync(full).size });
      } catch {
        // Vanished between the listing and the stat; nothing to report.
      }
    }
  }
}

/**
 * One section, one artifact per file, every label blank.
 *
 * Not grouped, not paired, not titled. Guessing that two files are a before/after
 * because of their names would put a structure in the reviewer's head that nobody
 * verified. The caller edits this; that edit is the point.
 */
export function harvestSpec(files: readonly HarvestedFile[], base?: string): ReportSpec {
  if (files.length === 0) {
    throw badArgs('no image or video files found to harvest');
  }
  return {
    version: REPORT_SPEC_VERSION,
    sections: [
      {
        // Carries the placeholder `report` refuses, so a spec nobody edited
        // cannot be posted by accident.
        text: 'REPLACE THIS with what the report is about, then label every artifact below.',
        artifacts: files.map((file) => ({
          path: base ? relative(base, file.path).split(sep).join('/') : file.path,
          label: '',
        })),
      },
    ],
  };
}

export const serializeSpec = (spec: ReportSpec): string => `${JSON.stringify(spec, null, 2)}\n`;
