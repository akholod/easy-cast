import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scrubObservation, scrubText, serializeObservation } from '../scripts/probe/scrub.js';
import { checkInterlock, mayRunHere, CONSENT_FLAG } from '../scripts/probe/interlock.js';
import { main, nextRunNumber, plan, record, type Observation } from '../scripts/probe/run.js';
import { redact } from '../src/secret/redact.js';

const TOKEN = 'ghp_FAKETOKENFAKETOKENFAKETOKENFAKE0123';
const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('what must never reach a published fixture', () => {
  it.each([
    ['a github token', `body ${TOKEN} end`, TOKEN],
    ['an Authorization header', 'Authorization: Bearer gho_SECRETSECRETSECRETSECRET1234', 'gho_SECRET'],
    ['a Set-Cookie value', 'Set-Cookie: session=abc123; Path=/', 'abc123'],
    ['a request id', '"x-github-request-id": "C4E2:1F3A:9BD0"', 'C4E2:1F3A:9BD0'],
    ['a signed url', 'https://x.invalid/a?jwt=eyJhbGciOiJIUzI1NiJ9.body.sig', 'eyJhbGciOiJIUzI1NiJ9'],
    ['an amazon signature', 'https://x.invalid/a?X-Amz-Signature=deadbeefcafe', 'deadbeefcafe'],
    ['an asset uuid', `https://github.com/user-attachments/assets/${UUID}`, UUID],
  ])('removes %s', (_label, input, secret) => {
    expect(scrubText(input)).not.toContain(secret);
  });

  // P3: one redactor. A parallel implementation would drift, and the copy nobody
  // remembered updating would be the one that leaked. These two together show
  // composition: identical where redact already decides, different only where the
  // probe adds a rule of its own.
  it('defers to redact wherever redact already has an answer', () => {
    const input = `token ${TOKEN} and Authorization: Bearer gho_SECRETSECRETSECRETSECRET1234`;
    expect(scrubText(input)).toBe(redact(input));
  });

  it('adds observation-specific rules on top rather than replacing them', () => {
    const input = `asset ${UUID}`;
    expect(redact(input)).toBe(input);
    expect(scrubText(input)).not.toBe(input);
  });

  it('leaves the parts that are actually the evidence intact', () => {
    const body = '{"message":"content_type is not included in the list of allowed content types"}';
    expect(scrubText(body)).toBe(body);
  });
});

describe('scrubbing a whole record', () => {
  it('reaches strings at any depth, including inside arrays', () => {
    const scrubbed = scrubObservation({
      responseHeaders: { authorization: `Bearer ${TOKEN}`, via: ['1.1 varnish', `x ${TOKEN}`] },
      nested: { deep: { deeper: TOKEN } },
      httpStatus: 201,
    });
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
    expect(scrubbed.httpStatus).toBe(201);
  });

  it('serialises one scrubbed line, so there is no unscrubbed path to the file', () => {
    const line = serializeObservation({ note: TOKEN });
    expect(line.endsWith('\n')).toBe(true);
    expect(line).not.toContain(TOKEN);
    expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe('the interlock', () => {
  const env = (repo?: string) => (repo === undefined ? {} : { EASY_CAST_PROBE_REPO: repo });

  it('allows a run only when every condition holds at once', () => {
    expect(checkInterlock(env('akholod/easy-cast-probe'), [CONSENT_FLAG])).toEqual({
      ok: true,
      repo: 'akholod/easy-cast-probe',
    });
  });

  it('refuses when the repository is not named', () => {
    const verdict = checkInterlock(env(), [CONSENT_FLAG]);
    expect(verdict.ok).toBe(false);
  });

  it('refuses without the consent flag', () => {
    const verdict = checkInterlock(env('akholod/easy-cast-probe'), []);
    expect(verdict.ok).toBe(false);
  });

  // An allowlist rather than a pattern: `*-probe` would accept a typo pointing at
  // a real repository, and the mess would be permanent.
  it.each([
    'akholod/easy-cast-probe2',
    'akholod/easy-cast',
    'someone/easy-cast-probe',
    'akholod/easy-cast-probe-public-2',
  ])('refuses %s, which merely resembles a probe repository', (repo) => {
    expect(checkInterlock(env(repo), [CONSENT_FLAG]).ok).toBe(false);
  });

  it('keeps public-repo cases off the private probe repository', () => {
    expect(mayRunHere('akholod/easy-cast-probe', true)).toBe(false);
    expect(mayRunHere('akholod/easy-cast-probe-public', true)).toBe(true);
    expect(mayRunHere('akholod/easy-cast-probe', false)).toBe(true);
  });
});

describe('the runner', () => {
  const scratch = () => join(mkdtempSync(join(tmpdir(), 'easy-cast-run-')), 'observations.jsonl');

  const say = () => {
    const lines: string[] = [];
    return { log: (line: string) => lines.push(line), text: () => lines.join('\n') };
  };

  it('refuses and explains, without doing anything', () => {
    const sink = say();
    expect(main({}, [], sink.log, scratch())).toBe(2);
    expect(sink.text()).toContain('CAN NEVER BE DELETED');
    expect(sink.text()).toContain('EASY_CAST_PROBE_REPO is not set');
  });

  it('states the permanent cost before listing the work', () => {
    const sink = say();
    expect(main({ EASY_CAST_PROBE_REPO: 'akholod/easy-cast-probe' }, [CONSENT_FLAG], sink.log, scratch())).toBe(0);
    expect(sink.text()).toMatch(/will each leave an attachment that cannot be deleted/);
  });

  // This test suite once appended ten records to the repository's real
  // observation log, because main() defaulted to it. That both polluted the
  // evidence and inflated the run counter, which exists to make repeats visible.
  it('never writes to the repository observation log', () => {
    const real = resolve(import.meta.dirname, '../fixtures/endpoint/observations.jsonl');
    const before = existsSync(real) ? readFileSync(real, 'utf8') : '';
    main({ EASY_CAST_PROBE_REPO: 'akholod/easy-cast-probe' }, [CONSENT_FLAG], () => {}, scratch());
    const after = existsSync(real) ? readFileSync(real, 'utf8') : '';
    expect(after).toBe(before);
  });

  it('withholds the public-repo cases from the private repository', () => {
    const priv = plan('akholod/easy-cast-probe');
    const pub = plan('akholod/easy-cast-probe-public');
    expect(priv.cases.some((c) => c.requiresPublicRepo)).toBe(false);
    expect(pub.cases.some((c) => c.requiresPublicRepo)).toBe(true);
  });
});

describe('the observation file', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'easy-cast-probe-'));
    path = join(dir, 'observations.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const observation = (over: Partial<Observation> = {}): Observation => ({
    run: 1,
    caseId: 'shape.multipart-vs-raw',
    group: 'request-shape',
    question: 'q',
    at: '2026-08-16T00:00:00Z',
    status: 'observed',
    ...over,
  });

  it('starts at run 1 and counts up, so a repeat is visible', () => {
    expect(nextRunNumber(path)).toBe(1);
    record(observation({ run: 1 }), path);
    expect(nextRunNumber(path)).toBe(2);
    record(observation({ run: 2 }), path);
    expect(nextRunNumber(path)).toBe(3);
  });

  it('writes scrubbed records only', () => {
    record(observation({ note: `saw ${TOKEN}`, responseBody: `asset ${UUID}` }), path);
    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain(UUID);
  });

  it('survives a damaged line when working out the next run number', () => {
    record(observation({ run: 4 }), path);
    appendFileSync(path, '{"run":');
    expect(nextRunNumber(path)).toBe(5);
  });
});
