/**
 * Conditions worth telling the caller about that are not, by themselves, a
 * failure. The set is closed and machine-readable: the primary consumer is an
 * agent, and free-form strings would make this the one field it cannot act on.
 */
export type AnomalyCode =
  | 'duplicate-markers'
  | 'malformed-ledger'
  | 'duplicate-ledger-delimiter'
  | 'ledger-block-quarantined'
  | 'journal-line-quarantined'
  | 'multiple-push-urls'
  | 'plan-divergence';

export interface Anomaly {
  readonly code: AnomalyCode;
  readonly detail: string;
}

export const anomaly = (code: AnomalyCode, detail: string): Anomaly => ({ code, detail });
