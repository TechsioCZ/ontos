import { assessAntiResurrection } from '@app/privacy/domain/anti-resurrection';
import type { AntiResurrectionAttempt, AntiResurrectionNewSourceEvidence } from '@app/privacy/domain/anti-resurrection';
import { Effect } from 'effect';

import { CommunicationsAntiResurrectionProtections } from './anti-resurrection-protections.ts';
import { ResurrectionBlocked } from './resurrection-blocked.ts';

/**
 * Anti-Resurrection for Communications' own data (#604, #605, PRIV-COM-13). After a measure was SEPARATELY executed by an
 * authorized owner Action, stale material of that exact subject, resource and content scope must not come back as Current
 * through an import, a replay, a projection rebuild or a backup recovery. The guard only REFUSES the re-exposure or use:
 * it deletes nothing, rewrites no backup and never schedules a cleanup of the old copy. It is not a subject blacklist: other
 * resources, other content and a newly proven source input stay usable, and a protection with no authoritative
 * evidence does not exist, so nothing is blocked on a guess.
 */

/** What may continue when nothing matched: every resource the attempt named. */
export interface ResurrectionClearance {
  readonly allowedResourceRefs: readonly string[];
  readonly decision: 'ALLOW';
}

/**
 * Checks one import, replay, projection rebuild or backup recovery against the subject's protections. A blocked or partly
 * blocked attempt fails with `ResurrectionBlocked` (the caller may continue only with `unaffectedResourceRefs`); an
 * unreadable protection store fails closed with `ProtectionLookupUnavailable`.
 */
export const guardAgainstResurrection = Effect.fn('CommunicationsAntiResurrection.guard')(function* guard(
  attempt: AntiResurrectionAttempt,
  trustedNewSourceEvidence?: AntiResurrectionNewSourceEvidence,
) {
  const protections = yield* CommunicationsAntiResurrectionProtections;
  const known = yield* protections.forSubject(attempt.tenantId, attempt.subjectRef);
  const assessment = assessAntiResurrection(known, attempt, trustedNewSourceEvidence);
  if (assessment.decision === 'ALLOW') {
    return {
      allowedResourceRefs: assessment.unaffectedResourceRefs,
      decision: 'ALLOW',
    } satisfies ResurrectionClearance;
  }
  return yield* new ResurrectionBlocked({
    blockedResourceRefs: assessment.blockedResourceRefs,
    matchedProtectionIds: assessment.matchedProtectionIds,
    operation: attempt.operation,
    unaffectedResourceRefs: assessment.unaffectedResourceRefs,
  });
});
