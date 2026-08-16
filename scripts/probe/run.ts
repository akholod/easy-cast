import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { casesInRunOrder, permanentAssetCount, type ProbeCase } from './cases.js';
import { checkInterlock, mayRunHere, CONSENT_FLAG, PROBE_REPOS } from './interlock.js';
import { serializeObservation } from './scrub.js';

/**
 * Stage 0: establish what the undocumented attachments endpoint actually does.
 *
 * This script exists so the answers are reproducible and reviewable instead of
 * living in one person's shell history. It is not a normal part of using the tool
 * and is never published (`tsconfig.build.json` covers `src` only).
 */

const OBSERVATIONS = resolve(import.meta.dirname, '../../fixtures/endpoint/observations.jsonl');

export interface Observation {
  readonly run: number;
  readonly caseId: string;
  readonly group: string;
  readonly question: string;
  readonly at: string;
  readonly status: 'observed' | 'not-testable' | 'skipped';
  /** Verbatim, after scrubbing — the body is the evidence, not our summary of it. */
  readonly httpStatus?: number;
  readonly responseBody?: string;
  readonly responseHeaders?: Record<string, string | string[]>;
  readonly note?: string;
}

/** Visible so a repeat run is obvious rather than blending into the file. */
export function nextRunNumber(path: string = OBSERVATIONS): number {
  if (!existsSync(path)) return 1;
  const runs = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return (JSON.parse(line) as Observation).run ?? 0;
      } catch {
        return 0;
      }
    });
  return runs.length === 0 ? 1 : Math.max(...runs) + 1;
}

export function record(observation: Observation, path: string = OBSERVATIONS): void {
  mkdirSync(dirname(path), { recursive: true });
  // The only way to this file. There is deliberately no unscrubbed variant.
  appendFileSync(path, serializeObservation(observation));
}

function usage(missing: readonly string[]): string {
  return [
    'easy-cast probe — stage 0 endpoint observation',
    '',
    'Refusing to start. Missing:',
    ...missing.map((line) => `  - ${line}`),
    '',
    'This creates GitHub attachments that CAN NEVER BE DELETED.',
    `Run it only against a throwaway probe repository (${PROBE_REPOS.join(' or ')}):`,
    '',
    `  EASY_CAST_PROBE_REPO=${PROBE_REPOS[0]} \\`,
    `    node dist-scripts/probe/run.js ${CONSENT_FLAG}`,
    '',
  ].join('\n');
}

export function plan(repo: string): { cases: readonly ProbeCase[]; permanent: number } {
  const cases = casesInRunOrder().filter((probe) => mayRunHere(repo, probe.requiresPublicRepo));
  return { cases, permanent: permanentAssetCount(cases) };
}

/**
 * `observationsPath` is injectable so a test can exercise the whole entry point
 * without appending to the repository's real observation log — a test that writes
 * there would both pollute the evidence and inflate the run counter, which exists
 * precisely so that repeats are visible.
 */
export function main(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  log: (line: string) => void,
  observationsPath: string = OBSERVATIONS,
): number {
  const verdict = checkInterlock(env, argv);
  if (!verdict.ok) {
    log(usage(verdict.missing));
    return 2;
  }

  const { cases, permanent } = plan(verdict.repo);
  const run = nextRunNumber(observationsPath);

  // Stated before anything happens, not discovered afterwards.
  log(`probe run #${run} against ${verdict.repo}`);
  log(`${cases.length} cases, of which ${permanent} will each leave an attachment that cannot be deleted.`);
  if (run > 1) {
    log(`This file already records ${run - 1} previous run(s); every one of those left assets behind too.`);
  }
  log('');
  for (const probe of cases) log(`  ${probe.group.padEnd(20)} ${probe.id}`);
  log('');
  // Written, not merely printed. A run that got as far as being authorised is
  // itself a fact worth recording — otherwise the counter only ever reflects runs
  // that happened to complete, and repeats look cheaper than they are.
  record({
    run,
    caseId: 'run-start',
    group: 'request-shape',
    question: `probe run #${run} authorised against ${verdict.repo}`,
    at: new Date().toISOString(),
    status: 'observed',
    note: `${cases.length} cases planned, ${permanent} of them permanent`,
  }, observationsPath);

  log('Execution of the individual cases is performed interactively — each one is a');
  log('deliberate act, and its response body is the evidence that goes into the fixture.');

  return 0;
}

if (process.argv[1]?.endsWith('run.js')) {
  process.exitCode = main(process.env, process.argv.slice(2), (line) => process.stdout.write(`${line}\n`));
}
