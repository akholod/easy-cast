import { fetchAnonymous, fromResponse, gh, observe, save, upload } from './execute.js';
import { nextRunNumber } from './run.js';
import { checkInterlock } from './interlock.js';

/**
 * The case that decides DG4.
 *
 * If an asset uploaded against a PRIVATE repository becomes anonymously reachable
 * once its URL is quoted in a PUBLIC issue, then the `--allow-public` gate is
 * theatre: it blocks the safe direction and lets the dangerous one through. If it
 * stays unreachable, the gate is meaningful and stays.
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

  const beforePublic = await fetchAnonymous(url);
  say(`  anonymous GET before any public citation -> ${beforePublic.status}`);

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

  const afterPublic = await fetchAnonymous(url);
  say(`  anonymous GET after PUBLIC citation -> ${afterPublic.status}`);

  const reachable = afterPublic.status === 200 || afterPublic.status === 302;
  save(
    observe(run, 'public.asset-nature', 'public-block',
      'Is an asset uploaded against a PRIVATE repository reachable anonymously once quoted in a PUBLIC issue?',
      'observed',
      {
        httpStatus: afterPublic.status ?? undefined,
        note:
          `before public citation: ${beforePublic.status}; after: ${afterPublic.status}. ` +
          (reachable
            ? 'REACHABLE — the asset is account-scoped, not repository-scoped, so the --allow-public gate does not protect what it claims to.'
            : 'NOT reachable — visibility follows the repository the asset was uploaded against, so the --allow-public gate is meaningful.'),
      }),
  );

  say('');
  say(reachable
    ? 'DG4: the gate is theatre — a private-repo asset became public by being quoted.'
    : 'DG4: the gate is meaningful — the asset stayed unreachable despite a public citation.');
  say(`probe issue left for cleanup: ${PUBLIC_REPO}#${number}`);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
