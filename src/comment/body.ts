import { anomaly, type Anomaly } from '../anomalies.js';
import { escapeMarkdownLabel } from '../render.js';
import { LEDGER_CAP } from './ledger.js';
import type { MediaCategory } from '../media/mime-table.js';

/**
 * The comment body belongs to the tool in its entirety (D15).
 *
 * On the compose path the body is regenerated from scratch — no promise is made
 * about preserving anything a human typed into it. That is what makes the size
 * budget computable at all, and it removes a merge contract that was the most
 * error-prone part of an earlier design.
 *
 * The ledger-only path is the exception: it swaps the delimited block and passes
 * everything else through byte for byte. Preservation there is incidental, not a
 * guarantee.
 */

const LEDGER_BLOCK = /<!-- easy-cast:ledger:v\d+ [\s\S]*? -->/;

export function composeBody(parts: {
  marker: string;
  caption?: string;
  rendered: readonly string[];
  ledger: string;
}): string {
  const sections = [parts.marker];
  if (parts.caption) sections.push(escapeMarkdownLabel(parts.caption));
  sections.push(...parts.rendered);
  sections.push(parts.ledger);
  return sections.join('\n\n');
}

export interface LedgerReplacement {
  readonly body: string;
  readonly anomalies: Anomaly[];
}

/**
 * Used on the partial-failure path, where the visible content must not change but
 * the URLs of already-uploaded assets still have to be recorded. An HTML comment
 * renders as nothing, so the reviewer sees no difference.
 */
export function replaceLedgerBlock(existingBody: string, ledger: string): LedgerReplacement {
  if (!LEDGER_BLOCK.test(existingBody)) {
    return { body: `${existingBody}\n\n${ledger}`, anomalies: [] };
  }

  const anomalies: Anomaly[] = [];
  const occurrences = existingBody.match(new RegExp(LEDGER_BLOCK.source, 'g')) ?? [];
  if (occurrences.length > 1) {
    anomalies.push(
      anomaly('duplicate-ledger-delimiter', `replaced the first of ${occurrences.length} ledger blocks`),
    );
  }
  return { body: existingBody.replace(LEDGER_BLOCK, ledger), anomalies };
}

/**
 * A generous stand-in for an attachment URL, which is not known until after the
 * upload the budget is meant to gate. Being wrong high only costs a rejected
 * batch; being wrong low would let a body exceed GitHub's limit *after* the
 * irreversible uploads had already happened.
 */
const URL_RESERVE_BYTES = 256;
/** GitHub rejects comment bodies past 65536; leave room rather than sit on the edge. */
export const BODY_BUDGET_BYTES = 60_000;

const MARKDOWN_OVERHEAD_PER_ATTACHMENT = 16;
const LEDGER_ENTRY_OVERHEAD = 16;
const DIGEST_BYTES = 96;

export function estimateBodyBytes(parts: {
  marker: string;
  caption?: string;
  files: readonly { name: string; category: MediaCategory }[];
  ledgerEntryCount: number;
}): number {
  let total = Buffer.byteLength(parts.marker) + 4;
  if (parts.caption) total += Buffer.byteLength(escapeMarkdownLabel(parts.caption)) + 2;

  for (const file of parts.files) {
    total +=
      Buffer.byteLength(escapeMarkdownLabel(file.name)) +
      URL_RESERVE_BYTES +
      MARKDOWN_OVERHEAD_PER_ATTACHMENT +
      2;
  }

  const entries = Math.min(parts.ledgerEntryCount, LEDGER_CAP);
  total += 64 + entries * (DIGEST_BYTES + URL_RESERVE_BYTES + LEDGER_ENTRY_OVERHEAD);

  return total;
}

