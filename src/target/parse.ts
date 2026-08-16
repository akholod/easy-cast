import { badArgs } from '../errors.js';

export type TargetSpec =
  | { readonly kind: 'pr'; readonly number: number }
  | { readonly kind: 'issue'; readonly number: number }
  | { readonly kind: 'pr-from-branch' };

const FORM = /^(pr|issue):(\d+)$/;

/**
 * Deliberately strict. `--to` addresses something the tool is about to post
 * irreversible content against, so a form we are not certain of is refused rather
 * than coerced into the nearest plausible number.
 */
export function parseTarget(raw: string): TargetSpec {
  const value = raw.trim();
  if (value === 'pr') return { kind: 'pr-from-branch' };

  const match = FORM.exec(value);
  if (!match) {
    throw badArgs(
      `--to must be one of: pr, pr:<number>, issue:<number>; got ${JSON.stringify(raw)}`,
    );
  }

  const [, kind, digits] = match;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw badArgs(`--to expects a positive issue or pull request number; got ${JSON.stringify(raw)}`);
  }
  return kind === 'pr' ? { kind: 'pr', number } : { kind: 'issue', number };
}
