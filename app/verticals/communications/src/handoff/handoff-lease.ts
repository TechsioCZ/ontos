/**
 * The lease of the owner's Core Outbox worker `communications.core.prepare-message-handoff` (#1403). It is the ONE existing
 * bound this owner has for "how long may one delivery of the pre-handoff step run": Core reclaims a claim whose lease expired,
 * and the step bounds its provider call by it, so a call can never outlive it. Reconciliation reads the same number to decide
 * that an attempt prepared longer ago than the lease has no call that can still answer. It is Core's lease, not a retry
 * count, interval or backoff, and it is named once so the worker, the call bound and the reconciliation cannot drift apart.
 */
export const PREPARE_MESSAGE_HANDOFF_LEASE_MS = 30_000;
