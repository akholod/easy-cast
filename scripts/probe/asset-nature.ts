import { fetchAnonymous, fromResponse, gh, observe, save, upload } from './execute.js';
import { nextRunNumber } from './run.js';
import { checkInterlock } from './interlock.js';

/**
 * The case that decides DG4: does uploading against a PRIVATE repository protect
 * an asset once its URL is quoted in a PUBLIC issue?
 *
 * The test that matters is on the **rendered** URL, not the canonical one. The
 * canonical `user-attachments/assets/<uuid>` URL answers 404 to everyone, always;
 * an earlier version of this script concluded from that number that the asset was
 * protected, and was wrong. What a reader's browser actually loads is the
 * short-lived signed URL GitHub substitutes when it renders the comment, so that
 * is what gets fetched here without credentials.
 *
 * Kept in one process on purpose. The asset UUID is scrubbed out of the
 * observation log — correctly, since that log is published — so the URL must never
 * need to be read back from it.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const PRIVATE_REPO = 'akholod/easy-cast-probe';
const PUBLIC_REPO = 'akholod/easy-cast-probe-public';
const say = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  const verdict = checkInterlock(process.env, process.argv.slice(2));
  if (!verdict.ok) {
    say(`refusing to start:\n  ${verdict.missing.join('\n  ')}`);
    return 2;
  }
  const privateId = Number(process.env.EASY_CAST_PRIVATE_REPO_ID);
  const publicId = Number(process.env.EASY_CAST_PUBLIC_REPO_ID);
  if (!privateId || !publicId) {
    say('need EASY_CAST_PRIVATE_REPO_ID and EASY_CAST_PUBLIC_REPO_ID');
    return 2;
  }

  const run = nextRunNumber();
  say(`asset-nature run #${run}`);

  const uploaded = await upload(PNG, 'dg4-private.png', 'image/png', privateId);
  save(
    observe(run, 'public.asset-nature.upload', 'public-block',
      'Upload against the PRIVATE repository, to be quoted publicly.', 'observed',
      fromResponse(uploaded)),
  );
  if (uploaded.status !== 201) {
    say(`  upload failed: ${uploaded.status}`);
    return 1;
  }
  const url = (JSON.parse(uploaded.body) as { url: string }).url;
  say(`  uploaded against the private repo (url held in-process only)`);

  // Recorded for completeness only. The canonical URL answers 404 to everyone in
  // every case, so on its own it settles nothing — an earlier version of this
  // script concluded DG4 from exactly this number and was wrong.
  const beforePublic = await fetchAnonymous(url);
  say(`  anonymous GET of the canonical URL (always 404, proves nothing) -> ${beforePublic.status}`);

  const issue = await gh(
    ['api', `repos/${PUBLIC_REPO}/issues`, '--method', 'POST', '--input', '-'],
    JSON.stringify({
      title: '[easy-cast-probe] asset nature (DG4)',
      body: `Quoting an asset uploaded against the private probe repository:\n\n![probe](${url})`,
    }),
  );
  if (!issue.ok) {
    say(`  could not create the public issue: ${issue.out.slice(0, 200)}`);
    return 1;
  }
  const number = (JSON.parse(issue.out) as { number: number }).number;
  say(`  quoted it in ${PUBLIC_REPO}#${number}`);

  // Give GitHub a moment to process the reference before concluding anything.
  await new Promise((r) => setTimeout(r, 5000));

  // The question is what a READER can fetch, and a reader never touches the
  // canonical URL — the browser loads the signed URL GitHub substitutes when it
  // renders the comment. That rewrite is the only thing worth testing here.
  const rendered = await gh([
    'api', `repos/${PUBLIC_REPO}/issues/${number}`,
    '-H', 'Accept: application/vnd.github.html+json', '--jq', '.body_html',
  ]);
  const signed = /<img src="([^"]+)"/.exec(rendered.out)?.[1]?.replace(/&amp;/g, '&');
  if (!signed) {
    say('  could not read the rendered image URL; DG4 is not answered by this run.');
    save(
      observe(run, 'public.asset-nature', 'public-block',
        'Is an asset uploaded against a PRIVATE repository reachable anonymously once quoted in a PUBLIC issue?',
        'not-testable', { note: 'body_html carried no <img>; the rewrite could not be inspected.' }),
    );
    return 1;
  }

  const afterPublic = await fetchAnonymous(signed);
  say(`  anonymous GET of the RENDERED signed URL -> ${afterPublic.status}`);

  const reachable = afterPublic.status === 200 || afterPublic.status === 302;
  save(
    observe(run, 'public.asset-nature', 'public-block',
      'Is an asset uploaded against a PRIVATE repository reachable anonymously once quoted in a PUBLIC issue?',
      'observed',
      {
        httpStatus: afterPublic.status ?? undefined,
        note:
          `canonical URL before public citation: ${beforePublic.status} (always 404, proves nothing). ` +
          `RENDERED signed URL after public citation, fetched with no credentials: ${afterPublic.status}. ` +
          (reachable
            ? 'REACHABLE — access follows who can read the COMMENT, not the repository the asset was uploaded against. The gate protects only because attach quotes where it uploads.'
            : 'NOT reachable — visibility follows the repository the asset was uploaded against.'),
      }),
  );

  say('');
  say(reachable
    ? 'DG4: a private-repo asset became readable by anyone once quoted publicly.'
    : 'DG4: the asset stayed unreachable despite a public citation.');
  say(`probe issue left for cleanup: ${PUBLIC_REPO}#${number}`);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
