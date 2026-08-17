import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyUploadResponse,
  CLASSIFICATION_PROVENANCE,
  CLASSIFICATION_VERSION,
} from '../src/upload/classify.js';
import { buildUploadRequest, UPLOAD_ORIGIN } from '../src/upload/wire.js';
import { createUploadPort } from '../src/upload/upload.js';
import type { Transport } from '../src/upload/transport.js';

const NO_HEADERS = {};

/**
 * The bodies below are the ones stage 0 actually received. Fixtures rather than
 * invented strings: a classifier tested against strings someone imagined agrees
 * with the imagination, not with GitHub.
 *
 * One substitution: the asset UUID is fabricated. A real one is a capability —
 * it identifies bytes that can never be deleted — and this repository is public.
 * The scrubber redacts UUIDs out of the observation log for exactly that reason,
 * and a test fixture is no different. Only the id is replaced; the shape, which
 * is what the classifier checks, is untouched.
 */
const CREATED = '{"url":"https://github.com/user-attachments/assets/00000000-1111-2222-3333-444444444444"}';
const NOT_FOUND = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}';
const BOTH_REASONS =
  '{"message":"Validation Failed","errors":[' +
  '{"resource":"UserAsset","code":"custom","field":"content_type","message":"content_type is not included in the list of allowed content types"},' +
  '{"resource":"UserAsset","code":"custom","field":"name","message":"name has a file extension that does not match the content type: .png != application/octet-stream"}]}';
// Never actually observed with one reason alone — both recorded 422s carried two.
// Kept to prove the message adapts, not as a claim that GitHub sends this.
const ONE_REASON =
  '{"message":"Validation Failed","errors":[{"resource":"UserAsset","code":"custom","field":"content_type",' +
  '"message":"content_type is not included in the list of allowed content types"}]}';
// Verbatim from the 2026-08-17 size probe, HTML and all. It was produced by
// declaring 5 GiB while sending 64 bytes, so it cost no attachment.
const TOO_BIG =
  '{"message":"Validation Failed","documentation_url":"https://docs.github.com/rest","errors":[' +
  '{"resource":"UserAsset","code":"custom","field":"size","message":"size Yowza that\'s a big file. ' +
  '\\u003cspan class=\'drag-and-drop-error-info\'\\u003e \\u003cspan class=\'btn-link\'\\u003eTry again' +
  '\\u003c/span\\u003e with a file size less than 10MB.\\u003c/span\\u003e"}]}';

describe('a file over the endpoint’s size ceiling', () => {
  it('is a known refusal, not an unknown: nothing was accepted', () => {
    const outcome = classifyUploadResponse(422, NO_HEADERS, TOO_BIG);
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'rejected_by_endpoint',
      state: 'known',
      retryable: false,
    });
  });

  // The message is written for the web UI. An agent should get the sentence, not
  // a span it might try to click.
  it('reports the endpoint’s own wording with the markup stripped out', () => {
    const outcome = classifyUploadResponse(422, NO_HEADERS, TOO_BIG);
    const message = outcome.ok ? '' : outcome.message;

    expect(message).toContain('with a file size less than 10MB.');
    expect(message).toContain("Yowza that's a big file.");
    expect(message).not.toContain('<span');
    expect(message).not.toContain('btn-link');
    // Collapsed, so removing the tags does not leave the gaps they occupied.
    expect(message).not.toMatch(/ {2}/);
  });
});

describe('the responses stage 0 actually saw', () => {
  it('reads the url out of a 201', () => {
    const outcome = classifyUploadResponse(201, NO_HEADERS, CREATED);
    expect(outcome).toEqual({
      ok: true,
      url: 'https://github.com/user-attachments/assets/00000000-1111-2222-3333-444444444444',
    });
  });

  // Three unrelated causes produce a byte-identical 404: a wrong repository_id, a
  // repository we can read but not push to, and an omitted repository_id.
  it('keeps a 404 disjunctive instead of naming one cause', () => {
    const outcome = classifyUploadResponse(404, NO_HEADERS, NOT_FOUND);
    expect(outcome).toMatchObject({ ok: false, reason: 'no_access_or_not_found', retryable: false });
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/cannot push/);
    expect(outcome.message).toMatch(/does not exist/);
    expect(outcome.message).toMatch(/id is wrong/);
  });

  it('reports both reasons when a 422 carries both', () => {
    const outcome = classifyUploadResponse(422, NO_HEADERS, BOTH_REASONS);
    expect(outcome).toMatchObject({ reason: 'rejected_by_endpoint' });
    if (outcome.ok) return;
    expect(outcome.message).toContain('not included in the list of allowed content types');
    expect(outcome.message).toContain('does not match the content type');
  });

  it('adapts the message when a 422 carries only one reason', () => {
    const outcome = classifyUploadResponse(422, NO_HEADERS, ONE_REASON);
    if (outcome.ok) return;
    expect(outcome.message).toContain('not included in the list');
    expect(outcome.message).not.toContain('does not match');
  });
});

describe('anything not observed', () => {
  // The default branch is the whole safety property: an unrecognised answer means
  // the endpoint may or may not have accepted the file.
  it.each([
    [403, '<html>abuse detection</html>'],
    [500, 'Internal Server Error'],
    [301, ''],
    [200, '{"url":"https://github.com/user-attachments/assets/00000000-1111-2222-3333-444444444444"}'],
    [418, '{"message":"teapot"}'],
    // Seen before recording began and never captured, so it is not a table row.
    [400, '{"message":"Invalid Content-Type"}'],
  ])('resolves %i to endpoint_unavailable, never retried', (status, body) => {
    expect(classifyUploadResponse(status, NO_HEADERS, body)).toMatchObject({
      reason: 'endpoint_unavailable',
      state: 'unknown',
      retryable: false,
    });
  });

  it.each([
    ['a body that is not json', 'not json at all'],
    ['a body with no url', '{"ok":true}'],
    ['a url of an unexpected shape', '{"url":"https://example.invalid/somewhere/else"}'],
    ['an empty url', '{"url":""}'],
    // A looser pattern accepted this, which would mean reporting an upload we
    // could never find again.
    ['a url whose id is not a uuid', '{"url":"https://github.com/user-attachments/assets/--------"}'],
    ['a url with a truncated uuid', '{"url":"https://github.com/user-attachments/assets/deadbeef"}'],
  ])('refuses to call a 201 successful given %s', (_label, body) => {
    expect(classifyUploadResponse(201, NO_HEADERS, body)).toMatchObject({
      reason: 'endpoint_unavailable',
      state: 'unknown',
    });
  });

  // A familiar status carrying an unfamiliar body means the endpoint changed under
  // us, which is exactly the case that must not be reported confidently. A 422
  // saying "Rate limited" would otherwise be reported as "the endpoint refused
  // this file", sending the caller to fix a file that was never the problem.
  it.each([
    [404, '<html>something else entirely</html>'],
    [404, '{"message":"Rate limited"}'],
    [404, '{"message":"Not Found somewhere in a longer sentence"}'],
    [422, '{"nothing":"recognisable"}'],
    [422, 'not json'],
    [422, '{"message":"Rate limited"}'],
    [422, '{"message":"Validation Failed","errors":[{"field":"something_else"}]}'],
  ])('treats %i with an unrecognised body as unknown, not as a known failure', (status, body) => {
    expect(classifyUploadResponse(status, NO_HEADERS, body)).toMatchObject({
      reason: 'endpoint_unavailable',
      state: 'unknown',
    });
  });

  it('keeps a token out of the excerpt it quotes back', () => {
    const outcome = classifyUploadResponse(500, NO_HEADERS, 'failed for ghp_FAKETOKENFAKETOKENFAKETOKENFAKE0123');
    if (outcome.ok) return;
    expect(outcome.message).not.toContain('ghp_FAKETOKENFAKETOKEN');
  });
});

describe('the request the endpoint actually wants', () => {
  const item = {
    fileName: 'shot.png',
    contentType: 'image/png',
    category: 'image' as const,
    bytes: Buffer.from('bytes'),
  };

  it('puts repository_id, name and size in the query and the type in the header', () => {
    const request = buildUploadRequest(item, { owner: 'o', repo: 'r', repositoryId: 42 }, 'gho_token');
    const url = new URL(request.url);

    expect(`${url.origin}${url.pathname}`).toBe(`${UPLOAD_ORIGIN}/user-attachments/assets`);
    expect(url.searchParams.get('repository_id')).toBe('42');
    expect(url.searchParams.get('name')).toBe('shot.png');
    expect(url.searchParams.get('size')).toBe('5');
    expect(request.headers['Content-Type']).toBe('image/png');
    expect(request.body).toBe(item.bytes);
  });

  // Omitting it answers 404 — the same answer as "no access" — so a missing id
  // would surface as a misleading diagnosis rather than as the bug it is.
  it('refuses to build a request without a repository id', () => {
    expect(() => buildUploadRequest(item, { owner: 'o', repo: 'r' }, 'gho_token')).toThrow(/repository_id/);
  });

  it('sends one request, because stage 0 found a single-phase protocol', async () => {
    let calls = 0;
    const transport: Transport = {
      send: async () => {
        calls += 1;
        return { phase: 'response', status: 201, headers: {}, body: CREATED };
      },
    };
    await createUploadPort(transport).upload(item, { owner: 'o', repo: 'r', repositoryId: 42 }, 't');
    expect(calls).toBe(1);
  });
});

describe('transport failures carry the right retry advice', () => {
  const item = {
    fileName: 'a.png',
    contentType: 'image/png',
    category: 'image' as const,
    bytes: Buffer.from('x'),
  };
  const target = { owner: 'o', repo: 'r', repositoryId: 1 };
  const port = (outcome: Awaited<ReturnType<Transport['send']>>) =>
    createUploadPort({ send: async () => outcome }).upload(item, target, 't');

  it('allows a retry only when no request byte ever reached the socket', async () => {
    const error = Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
    expect(await port({ phase: 'no-request-bytes', error })).toMatchObject({
      reason: 'network_unreachable',
      retryable: true,
      state: 'known',
    });
  });

  it('refuses a retry once the request had started, because the file may have landed', async () => {
    const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(await port({ phase: 'request-started', error })).toMatchObject({
      reason: 'endpoint_unavailable',
      retryable: false,
      state: 'unknown',
    });
  });
});

describe('the curated table stays in step with the code', () => {
  const table = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../fixtures/endpoint/classification.json'), 'utf8'),
  ) as {
    version: number;
    provenance: { run: string };
    rows: { status: number; outcome: string }[];
    default: { outcome: string };
    wire: { phases: number; validatesDeclaredSizeBeforeBody: boolean };
  };

  it('classifies every status the table records the way the table says', () => {
    for (const row of table.rows) {
      const body = row.status === 201 ? CREATED : row.status === 404 ? NOT_FOUND : BOTH_REASONS;
      const outcome = classifyUploadResponse(row.status, NO_HEADERS, body);
      const actual = outcome.ok ? 'ok' : outcome.reason;
      expect(actual).toBe(row.outcome);
    }
  });

  it('agrees that the declared size is checked before the body is read', () => {
    expect(table.wire.validatesDeclaredSizeBeforeBody).toBe(true);
  });

  it('agrees that the protocol is single phase', () => {
    expect(table.wire.phases).toBe(1);
  });

  it('agrees on the default', () => {
    expect(table.default.outcome).toBe('endpoint_unavailable');
  });

  // Ties the code to the evidence it was derived from. If the fixture is
  // regenerated from a later probe without the classifier being revisited, this
  // is what notices.
  it('was derived from the same probe run the fixture records', () => {
    expect(table.version).toBe(CLASSIFICATION_VERSION);
    for (const date of ['2026-08-16', '2026-08-17']) {
      expect(CLASSIFICATION_PROVENANCE).toContain(date);
      expect(table.provenance.run).toContain(date);
    }
  });
});
