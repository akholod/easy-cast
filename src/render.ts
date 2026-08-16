import type { MediaCategory } from './media/mime-table.js';

export interface RenderableAttachment {
  readonly url: string;
  readonly category: MediaCategory;
  readonly caption?: string;
  readonly name: string;
}

export interface BatchAttachment {
  readonly url: string;
  readonly category: MediaCategory;
  readonly name: string;
}

// GitHub only auto-embeds its native player when a video URL is the sole
// content of a line; wrapped in markdown or sharing a line with other text,
// it degrades to a dead link. Images carry no such restriction, so only
// video is special-cased here.
export function renderAttachment(a: RenderableAttachment): string {
  const body = a.category === 'video' ? a.url : `![${escapeMarkdownLabel(a.name)}](${a.url})`;
  if (!a.caption) return body;
  return `${escapeMarkdownLabel(a.caption)}\n\n${body}`;
}

// Argv order is preserved by construction: items are mapped in the order
// given, never sorted or grouped by category — the pipeline relies on it.
export function renderBatch(items: readonly BatchAttachment[], caption?: string): string {
  const blocks = items.map((item) => renderAttachment(item));
  if (!caption) return blocks.join('\n\n');
  return `${escapeMarkdownLabel(caption)}\n\n${blocks.join('\n\n')}`;
}

// Labels sit inside `![label](url)`, in a comment body that also carries a
// hidden marker and ledger block delimited by HTML comments elsewhere. A
// crafted file name or caption must not be able to close its label early,
// corrupt the URL delimiter, or — via a raw newline — spill onto a line of
// its own. Backslash is escaped first so the brackets/parens escaped next
// are not themselves re-escaped.
export function escapeMarkdownLabel(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/[[\]()]/g, (char) => `\\${char}`)
    .replace(/\r\n|\r|\n/g, ' ');
}
