import { Data } from 'effect';

/**
 * The typed, retryable failure that asks CORE to deliver the message again because an owner could not be ASKED (#1403 D10, #1396
 * BR-14): the source owner, Privacy, the recipient owner or the document owner was unavailable at the last stoppable handoff. The
 * step recorded an unproven stop and nothing was submitted to any provider, so a redelivery cannot send twice; it is a fresh
 * evaluation that asks every owner again. A REQUIRED security message must not be lost to a brief outage, and the stop completed
 * normally would have left the intent `PENDING_HANDOFF` with nothing to evaluate it again. It uses the same one retry
 * configuration as `NonAcceptanceRetryDue` (the descriptor's `retryPolicy`): no timer, queue, count or wait is added. An outage
 * that outlasts Core's own delivery budget leaves the delivery `dead` and the intent held (`NEEDS_REEVALUATION` in the history);
 * only a Core operator redrive then evaluates it again. A PROVEN stop is never redelivered.
 */
export class OwnerUnavailableRetryDue extends Data.TaggedError('OwnerUnavailableRetryDue')<{
  readonly intentId: string;
}> {}
