import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

/**
 * A generic HTTPS sender.
 *
 * It knows how to make one attempt and how to classify the way that attempt
 * ended. It knows nothing about what is being sent: no endpoint, no payload
 * shape, no notion of how many requests the protocol above it takes. The upload
 * protocol is undocumented; whatever shape it turns out to have is expressed by
 * the caller handing this module one request at a time, so establishing it
 * changes the caller and not this file.
 *
 * Uploaded attachments cannot be deleted, so the only question worth answering
 * about a failed attempt is whether the server might have received the bytes.
 * `no-request-bytes` answers "definitely not" and is the sole outcome a caller
 * may repeat; `request-started` answers "unknowable" and never is.
 */

export type TransportOutcome =
  | {
      readonly phase: 'response';
      readonly status: number;
      readonly headers: Record<string, string | string[]>;
      readonly body: string;
    }
  | { readonly phase: 'no-request-bytes'; readonly error: NodeJS.ErrnoException }
  | { readonly phase: 'request-started'; readonly error: NodeJS.ErrnoException };

export interface TransportRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export interface Transport {
  send(req: TransportRequest, signal: AbortSignal): Promise<TransportOutcome>;
}

/** The shape of `https.request`. Injectable so tests can drive a real server. */
export type HttpRequest = (
  url: string,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

const isSecure = (socket: Socket): socket is TLSSocket =>
  (socket as Partial<TLSSocket>).encrypted === true;

const responseHeaders = (raw: IncomingHttpHeaders): Record<string, string | string[]> => {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined) headers[name] = value;
  }
  return headers;
};

const framedHeaders = (headers: Record<string, string>, body: Buffer): Record<string, string> => {
  // The body is already whole in memory, so its length is a fact the caller
  // cannot state better. Left unlengthed, node frames the request chunked — a
  // shape an endpoint that documented nothing may simply refuse.
  const framed: Record<string, string> = { 'content-length': String(body.length) };
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-length') framed[name] = value;
  }
  return framed;
};

export function createTransport(request: HttpRequest = httpsRequest): Transport {
  const send = (req: TransportRequest, signal: AbortSignal): Promise<TransportOutcome> =>
    new Promise<TransportOutcome>((resolve) => {
      let settled = false;
      let started = false;
      let answer: { status: number; headers: Record<string, string | string[]> } | undefined;
      const received: Buffer[] = [];

      const settle = (outcome: TransportOutcome): void => {
        if (settled) return;
        settled = true;
        // Nothing further will be read. A body still streaming out has no reader
        // left, so stop it rather than leave a half-written request in flight.
        if (!clientRequest.writableFinished) clientRequest.destroy();
        resolve(outcome);
      };

      const settleResponse = (): void => {
        if (answer === undefined) return;
        settle({ ...answer, phase: 'response', body: Buffer.concat(received).toString('utf8') });
      };

      const settleError = (error: NodeJS.ErrnoException): void => {
        // A server that answered has already acted on the request; the write
        // error that follows adds nothing to what is known about its state.
        if (answer !== undefined) {
          settleResponse();
          return;
        }
        settle({ phase: started ? 'request-started' : 'no-request-bytes', error });
      };

      const clientRequest = request(
        req.url,
        { method: req.method, headers: framedHeaders(req.headers, req.body), signal },
        (res) => {
          answer = { status: res.statusCode ?? 0, headers: responseHeaders(res.headers) };
          res.on('data', (chunk: Buffer) => received.push(chunk));
          res.on('end', settleResponse);
          res.on('error', settleResponse);
          res.on('close', settleResponse);
        },
      );

      /**
       * The channel coming up — not a byte counter — is what separates the two
       * failure phases. Node hands the header block to the socket while it is
       * still connecting, so `bytesWritten` reports bytes that may never have
       * reached the wire; a request byte, on the other hand, cannot leave
       * before the TLS session (not merely the TCP one) is established, which
       * is exactly the DNS/TCP/TLS set D9' calls `no-request-bytes`.
       */
      clientRequest.on('socket', (socket: Socket) => {
        const up = (): void => {
          started = true;
        };
        // A pooled socket is up already and will never announce it again.
        if (clientRequest.reusedSocket) up();
        else if (isSecure(socket)) socket.once('secureConnect', up);
        else if (socket.connecting) socket.once('connect', up);
        else up();
      });
      clientRequest.on('error', settleError);
      // Exactly one attempt. A retry here would be invisible to the caller, and
      // an invisible retry of an upload is an attachment nobody can delete.
      clientRequest.end(req.body);
    });

  return { send };
}
