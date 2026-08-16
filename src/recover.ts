import { createJournal, type Journal } from './journal.js';
import { buildOutput, type CliJsonOutput } from './output.js';

/**
 * Makes the write-ahead log readable.
 *
 * Uploads are irreversible, so a URL recorded locally but never written into a
 * comment is not a curiosity — it is an asset that exists forever with nothing
 * pointing at it, and a repeat run that cannot see it would upload the same bytes
 * again. This command is how that backlog becomes visible before that happens.
 *
 * It only ever reads. Repair — writing the missing records into the comment —
 * belongs to a real `attach` run, which is the only place that knows the target.
 */
export function recover(journal: Journal): CliJsonOutput {
  const { events, anomalies: readAnomalies } = journal.readAll();
  const { pending, anomalies: foldAnomalies } = journal.foldPending();

  const recorded = events.filter((event) => event.ev === 'asset-recorded');

  return buildOutput({
    command: 'recover',
    reason: 'recover_report',
    // Every record is listed, not just the pending ones: an `upload` record has
    // no comment to be out of sync with, but losing sight of it entirely would
    // hide an asset that still exists.
    uploaded: recorded.map((event) => ({
      name: event.ev === 'asset-recorded' ? (event.u.split('/').pop() ?? '') : '',
      sourceHash: '',
      digest: event.d,
      status: 'uploaded' as const,
      url: event.ev === 'asset-recorded' ? event.u : undefined,
      state: 'known' as const,
      retryable: false,
    })),
    recovery: {
      journalPersisted: true,
      commentLedgerPersisted: pending.length === 0,
      repaired: false,
      pending: pending.map((record) => ({ scope: record.scope, digest: record.d, url: record.u })),
      journalPath: journal.path,
    },
    anomalies: [...readAnomalies, ...foldAnomalies],
    message:
      pending.length === 0
        ? `${recorded.length} recorded upload(s); nothing awaiting a comment.`
        : `${pending.length} upload(s) recorded locally but not yet written into a comment. ` +
          'Re-run the same attach command for each target to have them written.',
  });
}

export const recoverFromDir = (stateDir: string): CliJsonOutput => recover(createJournal(stateDir));
