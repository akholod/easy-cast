import type { MediaCategory } from '../media/mime-table.js';

/**
 * What the pipeline needs from the upload side, stated without any knowledge of
 * the protocol.
 *
 * The real implementation cannot be written until stage 0 establishes the wire
 * format, so the pipeline is built and tested against a stub whose only answer is
 * `endpoint_unavailable`. Keeping that seam here is what lets the two be built in
 * either order — and it is the same seam that absorbs a one-phase or two-phase
 * protocol without the pipeline noticing.
 */

export interface UploadTarget {
  readonly owner: string;
  readonly repo: string;
  readonly repositoryId?: number;
}

export interface UploadItem {
  readonly fileName: string;
  readonly contentType: string;
  readonly category: MediaCategory;
  readonly bytes: Buffer;
}

export type UploadOutcome =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly code: 5;
      readonly reason: 'endpoint_unavailable';
      readonly state: 'unknown';
      readonly retryable: false;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: 1;
      readonly reason: 'no_access_or_not_found' | 'rejected_by_endpoint' | 'network_unreachable';
      readonly state: 'known';
      readonly retryable: boolean;
      readonly message: string;
    };

export interface UploadPort {
  upload(item: UploadItem, target: UploadTarget, token: string): Promise<UploadOutcome>;
}

