/**
 * This is a table of hypotheses, not established fact. GitHub's docs describe
 * what its web UI accepts for attachments; the endpoint this CLI actually
 * calls is undocumented and returned a 422 in testing carrying two
 * contradictory complaints at once. Every row here is what the docs say, not
 * what the endpoint has been observed to do. WP-3b (see the implementation
 * plan) regenerates this table from S0's live observations.
 */

export type MediaCategory = 'image' | 'video';

export interface MediaKind {
  readonly contentType: string;
  readonly category: MediaCategory;
  readonly warnBytes: number;
}

interface MimeTableRow extends MediaKind {
  readonly extension: string;
}

export const MIME_TABLE_SOURCE = {
  sourceUrl:
    'https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files',
  checkedAgainstEndpointAt: '2026-08-16',
  retrievedAt: '2026-08-16',
} as const;

// GitHub documents 10 MB for images and free-plan video, 100 MB for paid-plan
// video. The caller's plan is unknown, so the lower, free-plan figure is used
// for both categories — warning early is harmless, but warning late because a
// paid-plan number was assumed would not be.
const DOCUMENTED_WARN_BYTES = 10 * 1024 * 1024;

export const MIME_TABLE: readonly MimeTableRow[] = [
  { extension: '.png', contentType: 'image/png', category: 'image', warnBytes: DOCUMENTED_WARN_BYTES },
  { extension: '.jpg', contentType: 'image/jpeg', category: 'image', warnBytes: DOCUMENTED_WARN_BYTES },
  { extension: '.jpeg', contentType: 'image/jpeg', category: 'image', warnBytes: DOCUMENTED_WARN_BYTES },
  { extension: '.gif', contentType: 'image/gif', category: 'image', warnBytes: DOCUMENTED_WARN_BYTES },
  { extension: '.svg', contentType: 'image/svg+xml', category: 'image', warnBytes: DOCUMENTED_WARN_BYTES },
  { extension: '.webp', contentType: 'image/webp', category: 'image', warnBytes: DOCUMENTED_WARN_BYTES },
  { extension: '.mp4', contentType: 'video/mp4', category: 'video', warnBytes: DOCUMENTED_WARN_BYTES },
  { extension: '.mov', contentType: 'video/quicktime', category: 'video', warnBytes: DOCUMENTED_WARN_BYTES },
  { extension: '.webm', contentType: 'video/webm', category: 'video', warnBytes: DOCUMENTED_WARN_BYTES },
];
