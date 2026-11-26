import { attemptMayHaveLeft, effectAfterObservations, submissionFactOfAttempt } from './delivery-result.ts';
import type { IntentTimelineFacts } from './timeline.ts';

/**
 * Whether ONE Message Intent is still waiting for any outcome (#1403 review): it is pending its handoff and nothing about it is
 * final. It is final when the intent is no longer pending, a PROVEN stop was recorded (a handoff stop, or a proven recovery stop),
 * or an attempt that may have left has a known effect (accepted, provably refused, or reconciled non-accepted). An intent with
 * no attempt, with only attempts that made no request, or whose attempts are all unknown is not final: the ordinary pre-handoff
 * step can still deliver it, so a deliberate copy of it must wait (the source can issue a new occurrence later).
 */
export const awaitsFirstOutcome = (facts: IntentTimelineFacts): boolean => {
  if (facts.intent.status !== 'PENDING_HANDOFF') {
    return false;
  }
  if (
    facts.stops.some(({ proven }) => proven) ||
    (facts.recoveries ?? []).some(({ outcome, proven }) => outcome === 'STOPPED' && proven)
  ) {
    return false;
  }
  return !facts.attempts.some((attempt) => {
    if (!attemptMayHaveLeft(attempt)) {
      return false;
    }
    const kinds = facts.observations.flatMap(({ attemptId, kind }) => (attemptId === attempt.attemptId ? [kind] : []));
    const effect = effectAfterObservations(submissionFactOfAttempt(attempt.state, attempt.reason).effect, kinds);
    return effect === 'PRESENT' || effect === 'ABSENT';
  });
};
