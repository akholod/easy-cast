/**
 * The gate in front of stage 0.
 *
 * Making an irreversible operation scriptable is what makes it cheap to repeat by
 * accident, and every successful probe leaves an attachment that can never be
 * deleted. Reproducibility was worth having anyway — this is the price of it.
 *
 * Kept separate from the entry point so it can be tested without executing
 * anything.
 */

export const PROBE_REPOS = ['akholod/easy-cast-probe', 'akholod/easy-cast-probe-public'] as const;
export const PUBLIC_PROBE_REPO = 'akholod/easy-cast-probe-public';
export const CONSENT_FLAG = '--i-understand-attachments-are-permanent';

export type InterlockVerdict = { readonly ok: true; readonly repo: string } | { readonly ok: false; readonly missing: string[] };

export function checkInterlock(env: NodeJS.ProcessEnv, argv: readonly string[]): InterlockVerdict {
  const missing: string[] = [];
  const repo = env.EASY_CAST_PROBE_REPO?.trim();

  if (!repo) {
    missing.push('EASY_CAST_PROBE_REPO is not set');
  } else if (!(PROBE_REPOS as readonly string[]).includes(repo)) {
    // An allowlist, not a pattern: `*-probe` would happily accept a typo that
    // pointed at somebody's real repository, and the mess would be permanent.
    missing.push(
      `EASY_CAST_PROBE_REPO is ${repo}, which is not one of the throwaway probe repositories ` +
        `(${PROBE_REPOS.join(', ')})`,
    );
  }

  if (!argv.includes(CONSENT_FLAG)) missing.push(`${CONSENT_FLAG} was not passed`);

  return missing.length === 0 ? { ok: true, repo: repo! } : { ok: false, missing };
}

/** Cases needing the public repository may only ever run against the public one. */
export const mayRunHere = (repo: string, requiresPublicRepo: boolean): boolean =>
  requiresPublicRepo ? repo === PUBLIC_PROBE_REPO : true;
