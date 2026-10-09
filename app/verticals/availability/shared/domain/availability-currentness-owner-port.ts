import { Context } from 'effect';
import type { Effect } from 'effect';
import type { AvailabilityEvaluationInput } from './availability-decision.ts';
import type { AvailabilityOwnerValidity } from './availability-currentness.ts';
import type { AvailabilityOwnerFailure } from './availability-owner-ports.ts';
import type { AvailabilitySubject, AvailabilityUseBoundary } from './availability-subject.ts';

export interface AvailabilityOwnerVerificationRequest {
  /** Exact candidate includes independently qualified backend authority and the resolved policy.
   * Coherence must authorize this complete snapshot; evaluation cannot substitute another policy. */
  readonly evidence: AvailabilityEvaluationInput;
  readonly subject: AvailabilitySubject;
  readonly useBoundary: AvailabilityUseBoundary;
}

export class AvailabilityOwnerValidityVerifier extends Context.Service<
  AvailabilityOwnerValidityVerifier,
  {
    readonly verify: (
      input: AvailabilityOwnerVerificationRequest,
    ) => Effect.Effect<AvailabilityOwnerValidity, AvailabilityOwnerFailure>;
  }
>()('@app/availability/shared/domain/availability-currentness-owner-port/AvailabilityOwnerValidityVerifier') {}
