import { Data } from 'effect';

/**
 * Carries a probe's result out of a transaction that always rolls back, so a write that the database
 * accepted is observed without keeping it. Each probe fails with this and catches it by tag at the
 * same seam, which is why the three boundary proofs share one declaration instead of repeating it.
 */
export class ProbeRollback<Value> extends Data.TaggedError('ProbeRollback')<{ readonly value: Value }> {}
