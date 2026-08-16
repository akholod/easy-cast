import { createTransport, type Transport } from './transport.js';
import { classifyUploadResponse } from './classify.js';
import { buildUploadRequest } from './wire.js';
import type { UploadItem, UploadPort, UploadTarget } from './port.js';

/**
 * One upload, one attempt.
 *
 * There is no retry anywhere in this file and there must never be one: a repeat
 * after an uncertain outcome could create a second attachment that nobody can
 * delete. The transport reports whether any request byte reached the socket, and
 * only the case where none did is safe to repeat — that decision belongs to the
 * caller reading `retryable`, not to a loop here.
 */
export function createUploadPort(transport: Transport = createTransport()): UploadPort {
  return {
    async upload(item: UploadItem, target: UploadTarget, token: string) {
      const request = buildUploadRequest(item, target, token);
      const controller = new AbortController();
      const outcome = await transport.send(request, controller.signal);

      if (outcome.phase === 'response') {
        return classifyUploadResponse(outcome.status, outcome.headers, outcome.body);
      }

      if (outcome.phase === 'no-request-bytes') {
        // Nothing reached the socket, so the endpoint cannot have accepted
        // anything. This is the only failure that is safe to repeat.
        return {
          ok: false,
          code: 1,
          reason: 'network_unreachable',
          state: 'known',
          retryable: true,
          message: `could not reach the endpoint (${outcome.error.code ?? outcome.error.message}); nothing was sent`,
        };
      }

      return {
        ok: false,
        code: 5,
        reason: 'endpoint_unavailable',
        state: 'unknown',
        retryable: false,
        message:
          `the connection failed after the request had started (${outcome.error.code ?? outcome.error.message}). ` +
          'The endpoint may or may not have accepted the file, so this will not be retried automatically.',
      };
    },
  };
}
