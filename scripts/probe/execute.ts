import { request } from 'node:https';
import { spawnScrubbed } from '../../src/secret/spawn.js';
import { record, type Observation } from './run.js';

/**
 * The stage-0 cases, executed.
 *
 * Assets are reused wherever a case only needs *an* asset URL rather than a fresh
 * one — citing an existing URL answers the publication-target and activation
 * questions just as well, and every avoided upload is one less permanent artefact.
 */

const TOKEN = process.env.EASY_CAST_PROBE_TOKEN ?? '';
const UPLOAD_HOST = 'uploads.github.com';
const UPLOAD_PATH = '/user-attachments/assets';

export interface RawResponse {
  readonly status: number | null;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  readonly error?: string;
}

export function upload(
  bytes: Buffer,
  name: string,
  contentType: string,
  repositoryId: number | undefined,
  token = TOKEN,
  /**
   * Overrides the declared `size` without changing what is sent.
   *
   * Only the size-ceiling case uses it, and it exists precisely so that case
   * costs nothing: asking about a 5 GiB limit by actually sending 5 GiB would
   * either take an hour or leave a 5 GiB attachment that can never be deleted.
   * Declaring the size and sending a few bytes asks the same question for free —
   * and if the endpoint answers about the mismatch instead, that is an answer
   * too, about the order in which it validates.
   */
  declaredSize = bytes.length,
): Promise<RawResponse> {
  const query = new URLSearchParams({ name, size: String(declaredSize) });
  if (repositoryId !== undefined) query.set('repository_id', String(repositoryId));

  return new Promise((resolve) => {
    const req = request(
      {
        host: UPLOAD_HOST,
        path: `${UPLOAD_PATH}?${query.toString()}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType,
          'Content-Length': bytes.length,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? null, headers: res.headers, body }));
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) =>
      resolve({ status: null, headers: {}, body: '', error: error.code ?? error.message }),
    );
    req.write(bytes);
    req.end();
  });
}

/** Anonymous GET, no credential at all — this is what a stranger would see. */
export function fetchAnonymous(url: string): Promise<{ status: number | null }> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const req = request(
      { host: parsed.host, path: parsed.pathname + parsed.search, method: 'GET' },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? null });
      },
    );
    req.on('error', () => resolve({ status: null }));
    req.end();
  });
}

const GH_ENV = ['HOME', 'XDG_CONFIG_HOME', 'PATH'];

export async function gh(args: string[], stdin?: string): Promise<{ ok: boolean; out: string }> {
  const result = await spawnScrubbed('gh', args, { allowEnv: GH_ENV, stdin });
  return { ok: result.exitCode === 0, out: result.exitCode === 0 ? result.stdout : result.stderr };
}

export const observe = (
  run: number,
  caseId: string,
  group: string,
  question: string,
  status: Observation['status'],
  extra: Partial<Observation> = {},
): Observation => ({
  run,
  caseId,
  group,
  question,
  at: new Date().toISOString(),
  status,
  ...extra,
});

export const fromResponse = (response: RawResponse): Partial<Observation> => ({
  httpStatus: response.status ?? undefined,
  responseBody: response.body.slice(0, 2000),
  responseHeaders: {
    'content-type': String(response.headers['content-type'] ?? ''),
    'x-github-request-id': String(response.headers['x-github-request-id'] ?? ''),
  },
  ...(response.error ? { note: `transport: ${response.error}` } : {}),
});

/** Every write goes through `record`, which scrubs. There is no other path. */
export const save = (observation: Observation, path?: string): void => record(observation, path);
