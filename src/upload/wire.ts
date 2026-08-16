import type { UploadItem, UploadTarget } from './port.js';

/**
 * The request shape, as established by stage 0.
 *
 * Single phase: one POST carrying the bytes, with the metadata in the query and
 * the declared type in the header. The plan allowed for a two-phase protocol
 * (policy call, then a POST elsewhere); it does not occur, so `transport.send` is
 * called once and `transport.ts` needed no knowledge of any of this.
 *
 * See docs/endpoint-semantics.md.
 */

export const UPLOAD_ORIGIN = 'https://uploads.github.com';
export const UPLOAD_PATH = '/user-attachments/assets';

export interface WireRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export function buildUploadRequest(item: UploadItem, target: UploadTarget, token: string): WireRequest {
  if (target.repositoryId === undefined) {
    // Omitting it answers 404, which is the same answer as "no access" — so a
    // missing id would surface as a misleading diagnosis rather than a bug report.
    throw new Error('buildUploadRequest: repository_id is required by the endpoint');
  }

  const query = new URLSearchParams({
    repository_id: String(target.repositoryId),
    name: item.fileName,
    size: String(item.bytes.length),
  });

  return {
    url: `${UPLOAD_ORIGIN}${UPLOAD_PATH}?${query.toString()}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // The declared type lives here, not in the query: a request with no
      // Content-Type answers 400. It must match the file extension, or the
      // endpoint refuses with 422 naming both facts.
      'Content-Type': item.contentType,
      'Content-Length': String(item.bytes.length),
    },
    body: item.bytes,
  };
}
