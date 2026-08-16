import { fetchAnonymous, fromResponse, gh, observe, save, upload } from './execute.js';
import { nextRunNumber } from './run.js';
import { checkInterlock } from './interlock.js';

/**
 * One stage-0 session against the private probe repository.
 *
 * Ordered cheapest-and-least-destructive first. The single asset uploaded by the
 * shape case is reused by every case that only needs *an* asset URL, so the
 * permanent footprint stays as small as the questions allow.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
/** A 1x1 GIF, so a second image type is tested with real bytes. */
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const REPO = 'akholod/easy-cast-probe';
const say = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  const verdict = checkInterlock(process.env, process.argv.slice(2));
  if (!verdict.ok) {
    say(`refusing to start:\n  ${verdict.missing.join('\n  ')}`);
    return 2;
  }
  const repositoryId = Number(process.env.EASY_CAST_PROBE_REPO_ID);
  if (!repositoryId) {
    say('need EASY_CAST_PROBE_REPO_ID');
    return 2;
  }

  const run = nextRunNumber();
  say(`probe run #${run} against ${verdict.repo}`);

  // ---- failures that create nothing -------------------------------------------
  const foreign = await upload(PNG, 'probe.png', 'image/png', 27193779); // cli/cli
  save(
    observe(run, 'failure.foreign-public-repo', 'failures',
      'Public repository we can read but not push to, with a working gho_ token?',
      foreign.status === null ? 'not-testable' : 'observed', fromResponse(foreign)),
  );
  say(`  foreign-public-repo -> ${foreign.status}`);

  const badId = await upload(PNG, 'probe.png', 'image/png', 999999999);
  save(
    observe(run, 'failure.bad-repository-id', 'failures',
      'Is a wrong repository_id distinguishable from missing push access?',
      'observed', fromResponse(badId)),
  );
  say(`  bad-repository-id -> ${badId.status}`);

  const mismatch = await upload(PNG, 'probe.png', 'application/octet-stream', repositoryId);
  save(
    observe(run, 'types.extension-content-type-mismatch', 'types-and-sizes',
      'Can the two 422 messages be produced separately, or do they arrive together?',
      'observed', fromResponse(mismatch)),
  );
  say(`  extension/content-type mismatch -> ${mismatch.status}`);

  const noId = await upload(PNG, 'probe.png', 'image/png', undefined);
  save(
    observe(run, 'shape.required-fields', 'request-shape',
      'Is repository_id required?', 'observed', fromResponse(noId)),
  );
  say(`  omitted repository_id -> ${noId.status}`);

  const disallowed = await upload(Buffer.from('log line\n'), 'probe.log', 'text/plain', repositoryId);
  save(
    observe(run, 'types.accepted-extensions', 'types-and-sizes',
      'Is a non-media type such as .log/text-plain accepted?', 'observed', fromResponse(disallowed)),
  );
  say(`  .log text/plain -> ${disallowed.status}`);

  // ---- one more real asset, so a second image type is covered ------------------
  const gif = await upload(GIF, 'probe.gif', 'image/gif', repositoryId);
  save(
    observe(run, 'types.accepted-extensions.gif', 'types-and-sizes',
      'Is image/gif accepted?', 'observed', fromResponse(gif)),
  );
  say(`  .gif -> ${gif.status}`);

  const assetUrl = (gif.status === 201 ? (JSON.parse(gif.body) as { url: string }).url : undefined);
  if (!assetUrl) {
    say('no asset URL to cite; stopping before the activation cases.');
    return 1;
  }

  // ---- activation, reusing the one asset --------------------------------------
  const before = await fetchAnonymous(assetUrl);
  save(
    observe(run, 'activation.before-citing', 'publication-targets',
      'Does a fresh asset URL resolve before anything quotes it?', 'observed',
      { httpStatus: before.status ?? undefined, note: 'anonymous GET, no credential' }),
  );
  say(`  anonymous GET before citing -> ${before.status}`);

  const issue = await gh(['api', `repos/${REPO}/issues`, '--method', 'POST', '--input', '-'],
    JSON.stringify({ title: '[easy-cast-probe] activation', body: 'holder' }));
  if (!issue.ok) {
    say(`  could not create probe issue: ${issue.out.slice(0, 200)}`);
    return 1;
  }
  const issueNumber = (JSON.parse(issue.out) as { number: number }).number;
  say(`  created probe issue #${issueNumber}`);

  const comment = await gh(
    ['api', `repos/${REPO}/issues/${issueNumber}/comments`, '--method', 'POST', '--input', '-'],
    JSON.stringify({ body: `![probe](${assetUrl})` }),
  );
  save(
    observe(run, 'targets.issue-comment', 'publication-targets',
      'Does a URL quoted in an issue comment activate and render?',
      comment.ok ? 'observed' : 'not-testable',
      { note: comment.ok ? 'comment created' : comment.out.slice(0, 300) }),
  );

  if (comment.ok) {
    const commentId = (JSON.parse(comment.out) as { id: number }).id;
    const rendered = await gh([
      'api', `repos/${REPO}/issues/comments/${commentId}`, '--jq', '.body_html',
    ]);
    save(
      observe(run, 'targets.issue-comment.render', 'publication-targets',
        'What host serves the rendered image, and is it an <img>?', 'observed',
        { note: rendered.out.slice(0, 400) }),
    );
    say(`  rendered html: ${rendered.out.slice(0, 160)}`);

    const after = await fetchAnonymous(assetUrl);
    save(
      observe(run, 'activation.after-citing', 'publication-targets',
        'Does the URL resolve anonymously once quoted in a PRIVATE repository?', 'observed',
        { httpStatus: after.status ?? undefined, note: 'anonymous GET after citing' }),
    );
    say(`  anonymous GET after citing -> ${after.status}`);
  }

  say(`\nprobe issue left open for cleanup: ${REPO}#${issueNumber}`);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
