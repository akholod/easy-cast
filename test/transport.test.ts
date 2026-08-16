import { afterEach, describe, expect, it } from 'vitest';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { createTransport, type TransportOutcome } from '../src/upload/transport.js';

/**
 * Two transports, both real: `plain` drives a live node:http server so a test
 * can dictate the exact bytes of an answer, `secure` is the shipped node:https
 * one and covers everything that happens before a request byte could exist.
 */
const plain = createTransport(httpRequest);
const secure = createTransport();

const teardown: Array<() => void> = [];
afterEach(() => {
  for (const close of teardown.splice(0)) close();
});

const track = (server: { close(): unknown; on(e: 'connection', l: (s: Socket) => void): unknown }) => {
  const open = new Set<Socket>();
  server.on('connection', (socket) => {
    open.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => open.delete(socket));
  });
  teardown.push(() => {
    for (const socket of open) socket.destroy();
    server.close();
  });
};

const listenHttp = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> => {
  const server = createHttpServer(handler);
  server.on('clientError', () => {});
  track(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

const listenTcp = async (handler: (socket: Socket) => void): Promise<number> => {
  const server = createTcpServer(handler);
  track(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

const closedPort = async (): Promise<number> => {
  const server = createHttpServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
};

const at = (port: number, scheme = 'http') => `${scheme}://127.0.0.1:${port}/upload`;
const never = () => new AbortController().signal;
const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Large enough that it cannot drain into an unread socket, so it is still going out. */
const streaming = () => Buffer.alloc(16 * 1024 * 1024, 0x61);

const asResponse = (outcome: TransportOutcome) => {
  if (outcome.phase !== 'response') expect.unreachable(`expected a response, got ${outcome.phase}`);
  return outcome;
};

describe('a server that answers', () => {
  it('reports the status, headers and body of the response', async () => {
    const port = await listenHttp((_req, res) => {
      res.writeHead(201, { 'x-answer': 'forty-two' });
      res.end('created');
    });

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: {}, body: Buffer.from('payload') },
      never(),
    );

    const response = asResponse(outcome);
    expect(response.status).toBe(201);
    expect(response.headers['x-answer']).toBe('forty-two');
    expect(response.body).toBe('created');
  });

  it('frames the request by the length of the body it was given, never chunked', async () => {
    const port = await listenHttp((req, res) => {
      res.writeHead(200, {
        'x-seen-length': String(req.headers['content-length'] ?? 'none'),
        'x-seen-encoding': String(req.headers['transfer-encoding'] ?? 'none'),
      });
      res.end('ok');
    });

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: { 'Content-Length': '999' }, body: Buffer.from('hello') },
      never(),
    );

    expect(asResponse(outcome).headers['x-seen-length']).toBe('5');
    expect(asResponse(outcome).headers['x-seen-encoding']).toBe('none');
  });
});

describe('failures before any request byte could have been written', () => {
  it('calls a refused connection no-request-bytes', async () => {
    const outcome = await secure.send(
      { url: at(await closedPort(), 'https'), method: 'POST', headers: {}, body: Buffer.from('x') },
      never(),
    );

    expect(outcome.phase).toBe('no-request-bytes');
    if (outcome.phase === 'no-request-bytes') expect(outcome.error.code).toBe('ECONNREFUSED');
  });

  it('calls a name that does not resolve no-request-bytes', async () => {
    const outcome = await secure.send(
      {
        url: 'https://easy-cast-does-not-exist.invalid/upload',
        method: 'POST',
        headers: {},
        body: Buffer.from('x'),
      },
      AbortSignal.timeout(5000),
    );

    expect(outcome.phase).toBe('no-request-bytes');
  }, 10_000);

  // TCP is up, so a byte counter would already be lying; the request rides the
  // TLS session, and that session never came up.
  it('calls a failed TLS handshake no-request-bytes', async () => {
    const port = await listenTcp((socket) => socket.end('this is not tls\r\n'));

    const outcome = await secure.send(
      { url: at(port, 'https'), method: 'POST', headers: {}, body: Buffer.from('x') },
      AbortSignal.timeout(3000),
    );

    expect(outcome.phase).toBe('no-request-bytes');
  });

  it('calls an abort during the TLS handshake no-request-bytes', async () => {
    const port = await listenTcp(() => {}); // accepts, then says nothing forever

    const outcome = await secure.send(
      { url: at(port, 'https'), method: 'POST', headers: {}, body: Buffer.from('x') },
      AbortSignal.timeout(100),
    );

    expect(outcome.phase).toBe('no-request-bytes');
  });

  it('calls a signal that was already aborted no-request-bytes', async () => {
    const port = await listenHttp((_req, res) => res.end('ok'));

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: {}, body: Buffer.from('x') },
      AbortSignal.abort(),
    );

    expect(outcome.phase).toBe('no-request-bytes');
  });
});

describe('failures once the request has begun', () => {
  // The conservative half of D9'. Not one body byte existed, and the answer is
  // still request-started: the headers alone may have been enough for the
  // server to act, and a wrong guess here costs an attachment nobody can delete.
  it('calls headers written with a zero-byte body request-started', async () => {
    let sawHeaders = false;
    const port = await listenHttp((req) => {
      sawHeaders = true;
      req.socket.destroy();
    });

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: {}, body: Buffer.alloc(0) },
      never(),
    );

    expect(sawHeaders).toBe(true);
    expect(outcome.phase).toBe('request-started');
  });

  it('calls a connection dropped while the body is going out request-started', async () => {
    const port = await listenHttp((req) => req.socket.destroy());

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: {}, body: streaming() },
      never(),
    );

    expect(outcome.phase).toBe('request-started');
  });

  it('calls an abort after the request reached the server request-started', async () => {
    const controller = new AbortController();
    const port = await listenHttp(() => controller.abort()); // never answers

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: {}, body: Buffer.from('x') },
      controller.signal,
    );

    expect(outcome.phase).toBe('request-started');
  });

  it('calls a timeout waiting for an answer request-started', async () => {
    const port = await listenHttp(() => {}); // never answers

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: {}, body: Buffer.from('x') },
      AbortSignal.timeout(100),
    );

    expect(outcome.phase).toBe('request-started');
  });
});

describe('an answer that arrives mid-transfer', () => {
  it('reports the response rather than the write error, with the body still going out', async () => {
    // Raw TCP: the answer goes out on the first byte of the request and the
    // 16 MB body is never read, so it is provably still in flight.
    const port = await listenTcp((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 413 Payload Too Large\r\nContent-Length: 9\r\nConnection: close\r\n\r\ntoo large',
        );
      });
    });

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: {}, body: streaming() },
      never(),
    );

    const response = asResponse(outcome);
    expect(response.status).toBe(413);
    expect(response.body).toBe('too large');
  });

  it('keeps the response even when the connection then breaks under it', async () => {
    const port = await listenTcp((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => {
        // Headers plus four of the promised nine body bytes, then the socket
        // dies: the read error is real, and the response still wins.
        socket.write(
          'HTTP/1.1 413 Payload Too Large\r\nContent-Length: 9\r\nConnection: close\r\n\r\ntoo ',
          () => setTimeout(() => socket.destroy(), 25),
        );
      });
    });

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: {}, body: streaming() },
      never(),
    );

    const response = asResponse(outcome);
    expect(response.status).toBe(413);
    expect(response.body).toBe('too ');
  });
});

describe('a single attempt', () => {
  it('does not repeat a request the connection dropped', async () => {
    let attempts = 0;
    const port = await listenHttp((req) => {
      attempts += 1;
      req.socket.destroy();
    });

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: {}, body: Buffer.from('x') },
      never(),
    );

    await settle(150);
    expect(outcome.phase).toBe('request-started');
    expect(attempts).toBe(1);
  });

  it('does not repeat a request the server answered with 500', async () => {
    let attempts = 0;
    const port = await listenHttp((_req, res) => {
      attempts += 1;
      res.writeHead(500);
      res.end('boom');
    });

    const outcome = await plain.send(
      { url: at(port), method: 'POST', headers: {}, body: Buffer.from('x') },
      never(),
    );

    await settle(150);
    expect(asResponse(outcome).status).toBe(500);
    expect(attempts).toBe(1);
  });
});
