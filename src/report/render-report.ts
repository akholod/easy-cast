import { basename } from 'node:path';
import { escapeMarkdownLabel } from '../render.js';
import type { MediaCategory } from '../media/mime-table.js';
import type { ReportArtifact, ReportComparison, ReportSpec } from './spec.js';

/**
 * The composed body of a report.
 *
 * `render.ts` renders one batch of attachments as a flat stack. This renders
 * structure: headings, per-artifact labels, side-by-side comparisons, and folds.
 * The difference matters to exactly one person — the reviewer, who otherwise has
 * to work out which of five screenshots is the one being talked about.
 *
 * Two rules are inherited rather than re-decided:
 *
 * - **A video URL must be the sole content of its line**, or GitHub renders a
 *   dead link instead of its player. Measured on 2026-08-17; see
 *   docs/endpoint-semantics.md. This is why a video can never go in a comparison
 *   table cell, and why `compare` refuses one.
 * - **Every label passes through `escapeMarkdownLabel`.** A label is caller text
 *   in a body that also carries HTML-comment delimiters; one that closed its own
 *   bracket early could corrupt the marker or the ledger.
 */

export interface ResolvedArtifact {
  readonly url: string;
  readonly category: MediaCategory;
}

/** path -> what it became. Missing entries are a programming error, not caller input. */
export type ArtifactResolution = ReadonlyMap<string, ResolvedArtifact>;

const image = (label: string, url: string): string => `![${escapeMarkdownLabel(label)}](${url})`;

const labelOf = (artifact: ReportArtifact): string => artifact.label ?? basename(artifact.path);

function renderOne(artifact: ReportArtifact, resolved: ArtifactResolution): string {
  const found = resolved.get(artifact.path);
  if (!found) throw new Error(`renderReport: no upload result for ${artifact.path}`);

  if (found.category === 'video') {
    // The label cannot share the line with the URL, so it becomes a sentence
    // above it rather than alt text.
    const url = found.url;
    return artifact.label ? `${escapeMarkdownLabel(artifact.label)}\n\n${url}` : url;
  }
  return image(labelOf(artifact), found.url);
}

function renderComparison(spec: ReportComparison, resolved: ArtifactResolution): string {
  const before = resolved.get(spec.before.path);
  const after = resolved.get(spec.after.path);
  if (!before || !after) throw new Error('renderReport: a comparison is missing an upload result');

  // A table cell cannot hold a video: the player only appears when the URL is the
  // sole content of a line, and a cell is never a line. Stacking them is worse
  // than admitting it, so the two are rendered one after the other with their
  // labels — the reviewer still gets both, in order, correctly playable.
  if (before.category === 'video' || after.category === 'video') {
    return [renderOne(spec.before, resolved), renderOne(spec.after, resolved)].join('\n\n');
  }

  const head = `| ${escapeMarkdownLabel(labelOf(spec.before))} | ${escapeMarkdownLabel(labelOf(spec.after))} |`;
  const rule = '| --- | --- |';
  const row = `| <img src="${before.url}" width="380"> | <img src="${after.url}" width="380"> |`;
  return [head, rule, row].join('\n');
}

function renderSection(section: ReportSpec['sections'][number], resolved: ArtifactResolution): string {
  const blocks: string[] = [];
  if (section.heading && !section.collapsed) blocks.push(`#### ${escapeMarkdownLabel(section.heading)}`);
  if (section.text) blocks.push(escapeMarkdownLabel(section.text));
  for (const artifact of section.artifacts ?? []) blocks.push(renderOne(artifact, resolved));
  if (section.compare) blocks.push(renderComparison(section.compare, resolved));

  const body = blocks.join('\n\n');
  if (!section.collapsed) return body;

  // The blank lines inside <details> are load-bearing: without them GitHub does
  // not parse the markdown they wrap.
  return `<details>\n<summary>${escapeMarkdownLabel(section.heading!)}</summary>\n\n${body}\n\n</details>`;
}

export function renderReport(spec: ReportSpec, resolved: ArtifactResolution): string {
  const blocks: string[] = [];
  if (spec.title) blocks.push(`### ${escapeMarkdownLabel(spec.title)}`);
  for (const section of spec.sections) blocks.push(renderSection(section, resolved));
  return blocks.join('\n\n');
}

/**
 * What the body will look like before anything has been uploaded.
 *
 * Used by `compose`, whose entire job is to let somebody read the comment they
 * are about to post. The placeholder is deliberately unmistakable: a plausible
 * fake URL would be a document that looks finished and is not.
 */
export function renderReportPreview(
  spec: ReportSpec,
  categoryOf: (path: string) => MediaCategory,
): string {
  const resolved = new Map<string, ResolvedArtifact>();
  for (const section of spec.sections) {
    for (const artifact of section.artifacts ?? []) placeholder(artifact);
    if (section.compare) {
      placeholder(section.compare.before);
      placeholder(section.compare.after);
    }
  }
  return renderReport(spec, resolved);

  function placeholder(artifact: ReportArtifact): void {
    resolved.set(artifact.path, {
      url: `NOT-UPLOADED-YET:${artifact.path}`,
      category: categoryOf(artifact.path),
    });
  }
}
