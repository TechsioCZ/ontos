import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { CommercePortalAuthStepUpChallengeRecord } from './contracts.ts';
import type { CommercePortalAuthStepUpUnavailable } from './unavailable.ts';

export interface CommercePortalAuthStepUpChallengeStore {
  /** Consume exactly once after the external code verifier has succeeded for this reservation. */
  readonly consume: (input: {
    readonly challengeIdHash: string;
    readonly now: Date;
    readonly providerSubjectId: string;
    readonly reservationId: string;
    readonly sessionId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthStepUpUnavailable>;
  /** Persist only the hashed opaque challenge id and the exact provider subject/session binding. */
  readonly create: (input: {
    readonly attemptsRemaining: number;
    readonly challengeIdHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
    readonly providerSubjectId: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, CommercePortalAuthStepUpUnavailable>;
  readonly findByChallengeIdHash: (
    challengeIdHash: string,
  ) => Effect.Effect<Option.Option<CommercePortalAuthStepUpChallengeRecord>, CommercePortalAuthStepUpUnavailable>;
  /** Finalize one reserved attempt after a known invalid code; the consumed budget is not refunded. */
  readonly recordFailure: (input: {
    readonly challengeIdHash: string;
    readonly now: Date;
    readonly providerSubjectId: string;
    readonly reservationId: string;
    readonly sessionId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthStepUpUnavailable>;
  /** Refund only the exact reservation after a provider outage; never refund another request. */
  readonly releaseAttempt: (input: {
    readonly challengeIdHash: string;
    readonly now: Date;
    readonly providerSubjectId: string;
    readonly reservationId: string;
    readonly sessionId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthStepUpUnavailable>;
  /** Reserve one available attempt before invoking the external code verifier. */
  readonly reserveAttempt: (input: {
    readonly challengeIdHash: string;
    readonly now: Date;
    readonly providerSubjectId: string;
    readonly reservationId: string;
    readonly sessionId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthStepUpUnavailable>;
}

export class CommercePortalAuthStepUpChallengeStoreService extends Context.Service<
  CommercePortalAuthStepUpChallengeStoreService,
  CommercePortalAuthStepUpChallengeStore
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/step-up/challenge-store-service/CommercePortalAuthStepUpChallengeStoreService',
) {}
