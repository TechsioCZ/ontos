/**
 * Every number on the Portal Auth redelivery path (#1403 D10, R-13, #1400 LC-15), in one place. The Portal Auth module invents no
 * retry count, interval or wait of its own.
 *
 * The lease and the redelivery policy: Core's descriptor type REQUIRES both on the submit worker and offers no default that can
 * be omitted. They are exactly what the Codesmith Outbox Worker generator writes into a new worker
 * (`scripts/scaffolding/outbox-worker/scaffold.mts`); `portal-auth-no-invented-recovery-numbers.test.ts` fails when they drift.
 * The relay (the Auth-local outbox's own sweep) reuses the same lease and backoff instead of a second set.
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

/**
 * The relay's tick interval. It is the documented default poll interval of Core's worker host (`OUTBOX_WORKER_POLL_INTERVAL_MS`,
 * 1,000 ms), which Core does not export; the relay is a loop of the same worker-host entry, so it keeps the same cadence.
 */
export const RELAY_POLL_INTERVAL_MS = 1000;

/**
 * Rows one relay tick claims. NOT a generated default: neither Core nor the generator offers a batch for this Auth-local outbox,
 * so it is a platform guard only. Each claimed row is leased from the claim, and a tick relays its rows one after another,
 * so a batch must stay small enough to be relayed within `leaseDurationMs`. Open question for the Core owner: whether Core can
 * publish a default claim batch for an owner-local outbox sweep.
 */
export const RELAY_CLAIM_LIMIT = 32;

/**
 * Overflow guard of the doubling backoff, not a retry limit: it keeps `retryMillis * multiplier ** attempts` finite, so a first
 * delay of zero never turns into `0 * Infinity`. The delay is always cut at `retryPolicy.maxBackoffMs`.
 */
export const RELAY_BACKOFF_EXPONENT_CAP = 20;
