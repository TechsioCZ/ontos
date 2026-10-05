import { Context, Schema } from 'effect';
import { AvailabilitySubjectSchema, AvailabilityUseBoundarySchema } from './availability-subject.ts';
import { AvailabilityCurrentDecisionSchema } from './availability-currentness.ts';
import type { Effect } from 'effect';
import type { OperationalScope, ReadHandlerUnavailable } from '@app/core-runtime';
import type { AvailabilityConsumerRequest } from './availability-consumer-contract.ts';
import type { AvailabilityCurrentnessEvidence } from './availability-currentness-evidence-port.ts';
import type { AvailabilityOwnerValidityVerifier } from './availability-currentness-owner-port.ts';
import type { AvailabilitySubject, AvailabilityUseBoundary } from './availability-subject.ts';
import type { AvailabilityCurrentDecision } from './availability-currentness.ts';

export interface AvailabilityConsumerResolvedRequest {
  readonly evaluatedAt: AvailabilityUseBoundary['requiredAt'];
  readonly previous?: AvailabilityCurrentDecision;
  readonly representedInBundle: boolean;
  readonly subject: AvailabilitySubject;
  readonly useBoundary: AvailabilityUseBoundary;
}

/** Server composition alone resolves identifiers, history and authority against governed Core scope. */
export class AvailabilityConsumerOwner extends Context.Service<
  AvailabilityConsumerOwner,
  {
    readonly readCurrent: typeof AvailabilityCurrentnessEvidence.Service.readCurrent;
    readonly resolve: (
      request: AvailabilityConsumerRequest,
      scope: OperationalScope,
    ) => Effect.Effect<AvailabilityConsumerResolvedRequest, ReadHandlerUnavailable>;
    readonly verify: typeof AvailabilityOwnerValidityVerifier.Service.verify;
  }
>()('@app/availability/shared/domain/availability-consumer-owner-port/AvailabilityConsumerOwner') {}

export const AvailabilityConsumerResolvedRequestSchema = Schema.Struct({
  evaluatedAt: AvailabilityUseBoundarySchema.fields.requiredAt,
  previous: Schema.optionalKey(AvailabilityCurrentDecisionSchema),
  representedInBundle: Schema.Boolean,
  subject: AvailabilitySubjectSchema,
  useBoundary: AvailabilityUseBoundarySchema,
});
