/**
 * The lease and the redelivery policy of this owner's Core Outbox Workers (#1403 R-13, #1400 LC-15).
 *
 * Core's descriptor type REQUIRES both on every Outbox Worker (`leaseDurationMs`, `retryPolicy`) and offers no default that can be
 * omitted, so a number has to be present. It is not this owner's number: it is exactly what the Codesmith Outbox Worker
 * generator writes into a new worker (`scripts/scaffolding/outbox-worker/scaffold.mts`), and the unit guard
 * `no-invented-recovery-numbers` fails when the two drift apart. This is the ONE place this owner holds them; no worker
 * descriptor carries a literal of its own.
 *
 * What they are NOT: a retry count, interval or wait of Communications. A type's own approved `RecoveryPolicy.maxAttempts`
 * (counted by Communications over its own attempt history, `domain/recovery/retry-eligibility.ts`) is the only limit of a
 * Technical Retry. Core's `retryPolicy` is only the cadence and ceiling of Core redelivering the same message, so a type
 * limit above `retryPolicy.maxAttempts` would be dead-lettered by Core first (visible to operators, never a send approval).
 * Whether Core can offer a default, or a redelivery that is not charged to its budget, is an open question for the Core owner.
 */
export const OUTBOX_WORKER_GENERATED_DEFAULTS = {
  leaseDurationMs: 30_000,
  retryPolicy: {
    initialBackoffMs: 1000,
    maxAttempts: 5,
    maxBackoffMs: 60_000,
    multiplier: 2,
  },
} as const;
