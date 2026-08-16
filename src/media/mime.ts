import { extname } from 'node:path';
import { MIME_TABLE, type MediaKind } from './mime-table.js';

/**
 * Our own ceiling, not GitHub's — see D6′. GitHub documents 10 MB for images
 * and free-plan video, 100 MB for paid-plan video, and the caller's plan is
 * unknown, so the endpoint stays the authority on anything below this. A size
 * rejection creates nothing irreversible, so being confidently wrong locally
 * is worse than one wasted request; this limit exists only to catch files no
 * documented plan would plausibly accept.
 */
const LOCAL_POLICY_LIMIT_BYTES = 100 * 1024 * 1024;

export type SizeCheck =
  | { level: 'ok' }
  | { level: 'warn'; message: string }
  | { level: 'reject'; message: string; policy: 'local_policy_limit' };

// Classification is by extension alone, never by sniffing content: the
// endpoint validates the declared type against the file name, and an
// observed 422 complained about exactly that mismatch.
export function classifyExtension(fileName: string): MediaKind | undefined {
  const extension = extname(fileName).toLowerCase();
  const row = MIME_TABLE.find((candidate) => candidate.extension === extension);
  if (!row) return undefined;
  return { contentType: row.contentType, category: row.category, warnBytes: row.warnBytes };
}

export function checkSize(byteLength: number, kind: MediaKind): SizeCheck {
  if (byteLength > LOCAL_POLICY_LIMIT_BYTES) {
    return {
      level: 'reject',
      message: `${byteLength} bytes exceeds easy-cast's own ${LOCAL_POLICY_LIMIT_BYTES}-byte limit — this is a product policy, not a GitHub limit.`,
      policy: 'local_policy_limit',
    };
  }
  // A warning never rejects: GitHub, not this CLI, decides whether to accept
  // a file above its documented threshold.
  if (byteLength >= kind.warnBytes) {
    return {
      level: 'warn',
      message: `${byteLength} bytes is at or above GitHub's documented ${kind.warnBytes}-byte threshold for this file type on some plans; GitHub may still accept it.`,
    };
  }
  return { level: 'ok' };
}
