import { gh, observe, save } from './execute.js';
import { nextRunNumber } from './run.js';
import { PROBE_REPOS } from './interlock.js';

/**
 * Closes the issues stage 0 opened.
 *
 * It does not claim to delete them: whether an issue can be deleted at all is
 * itself unverified, so this reports what actually happened rather than what it
 * hoped for.
 *
 * Attachments are never cleaned up, because they cannot be. That is the whole
 * reason the interlock in front of the probe exists.
 */

const PREFIX = '[easy-cast-probe]';
const say = (line: string) => process.stdout.write(`${line}\n`);

interface Issue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
}

async function cleanupRepo(repo: string, run: number): Promise<void> {
  const listed = await gh(['api', `repos/${repo}/issues?state=all&per_page=100`]);
  if (!listed.ok) {
    say(`  ${repo}: could not list issues — ${listed.out.slice(0, 160)}`);
    return;
  }

  const mine = (JSON.parse(listed.out) as Issue[]).filter((issue) => issue.title.startsWith(PREFIX));
  if (mine.length === 0) {
    say(`  ${repo}: nothing to clean up`);
    return;
  }

  const closed: number[] = [];
  const failed: number[] = [];
  for (const issue of mine) {
    if (issue.state === 'closed') {
      closed.push(issue.number);
      continue;
    }
    const result = await gh(
      ['api', `repos/${repo}/issues/${issue.number}`, '--method', 'PATCH', '--input', '-'],
      JSON.stringify({ state: 'closed' }),
    );
    (result.ok ? closed : failed).push(issue.number);
  }

  say(`  ${repo}: closed ${closed.length}${failed.length ? `, failed on ${failed.join(', ')}` : ''}`);
  save(
    observe(run, 'cleanup', 'public-block',
      'Can the probe issues be closed, and can they be deleted?', 'observed',
      {
        note:
          `${repo}: closed ${closed.map((n) => `#${n}`).join(', ') || 'none'}` +
          (failed.length ? `; could not close ${failed.map((n) => `#${n}`).join(', ')}` : '') +
          '. Deletion was not attempted: the REST API offers no issue deletion, so the honest ' +
          'statement is that these issues are closed, not removed. Their attachments remain ' +
          'reachable and cannot be removed at all.',
      }),
  );
}

async function main(): Promise<number> {
  const run = nextRunNumber();
  say(`cleanup, recorded as run #${run}`);
  for (const repo of PROBE_REPOS) await cleanupRepo(repo, run);
  say('');
  say('Attachments were NOT removed. They cannot be.');
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
