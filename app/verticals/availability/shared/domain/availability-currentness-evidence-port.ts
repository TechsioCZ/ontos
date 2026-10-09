import { Context } from 'effect';
import type { Effect } from 'effect';
import type { AvailabilityOwnerFailure } from './availability-owner-ports.ts';
import type { AvailabilitySubject, AvailabilityUseBoundary } from './availability-subject.ts';
import type { AvailabilityEvaluationInput } from './availability-decision.ts';

/** Read-only owner evidence seam; no Reservation, Confirmation, Order or provider fallback method. */
export interface AvailabilityEvidencePort<Evidence> {
  readonly readCurrent: (input: {
    readonly subject: AvailabilitySubject;
    readonly useBoundary: AvailabilityUseBoundary;
  }) => Effect.Effect<Evidence, AvailabilityOwnerFailure>;
}

export class AvailabilityCurrentnessEvidence extends Context.Service<
  AvailabilityCurrentnessEvidence,
  AvailabilityEvidencePort<AvailabilityEvaluationInput>
>()('@app/availability/shared/domain/availability-currentness-evidence-port/AvailabilityCurrentnessEvidence') {}
