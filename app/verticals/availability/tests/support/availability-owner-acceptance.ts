import { Effect, Layer } from 'effect';
import { AvailabilityCurrentnessEvidence } from '../../shared/domain/availability-currentness-evidence-port.ts';
import { AvailabilityOwnerValidityVerifier } from '../../shared/domain/availability-currentness-owner-port.ts';
import { availabilityMaterialOwners } from '../../shared/domain/availability-currentness.ts';
import type {
  AvailabilityCurrentDecision,
  AvailabilityOwnerValidity,
} from '../../shared/domain/availability-currentness.ts';
import type { AvailabilityEvaluationInput } from '../../shared/domain/availability-decision.ts';
import type { AvailabilityUseBoundary } from '../../shared/domain/availability-subject.ts';
import {
  availabilityCurrentnessOwnerLayer,
  availabilityCurrentnessService,
} from '../../src/services/availability-currentness.service.ts';
import type { AvailabilityCurrentnessRequest } from '../../src/services/availability-currentness.service.ts';

export const acceptanceObservedAt = '2026-10-05T12:00:00.000Z';
export const acceptanceLater = '2026-10-05T12:07:00.000Z';

/** Controlled owner-issued proof; Availability never constructs this proof in production. */
export const ownerProof = (
  evidence: AvailabilityEvaluationInput,
  useBoundary: AvailabilityUseBoundary,
  revision = 'R1',
): Extract<AvailabilityOwnerValidity, { readonly _tag: 'VALID' }> => ({
  _tag: 'VALID',
  coherence: 'OWNER_VERIFIED_COHERENT',
  evidence,
  materialEvidence: availabilityMaterialOwners.map((owner) => ({
    businessAt: acceptanceObservedAt,
    contractRef: `${owner}-currentness-contract`,
    evidenceRef: `${owner}-proof`,
    invalidationConditions: ['OWNER_MATERIAL_FACT_CHANGE', 'SET_INSERT_REMOVE_LIFECYCLE_SHARING_BINDING'],
    observedAt: acceptanceObservedAt,
    owner,
    sourceRevisionRefs: [revision],
    validFrom: acceptanceObservedAt,
  })),
  subject: evidence.subject,
  useBoundary,
});

export const currentRequest = (
  input: AvailabilityEvaluationInput,
  previous?: AvailabilityCurrentDecision,
  kind: AvailabilityUseBoundary['kind'] = 'ORDER_COMMITMENT',
): AvailabilityCurrentnessRequest => ({
  evaluatedAt: acceptanceLater,
  previous,
  representedInBundle: previous !== undefined,
  subject: input.subject,
  useBoundary: { kind, requiredAt: acceptanceLater },
});

/** Real Availability evaluator/policy/currentness with only published-owner evidence replaced. */
export const evaluateCurrent = (
  request: AvailabilityCurrentnessRequest,
  verify: typeof AvailabilityOwnerValidityVerifier.Service.verify,
  input: AvailabilityEvaluationInput,
  readCurrent: typeof AvailabilityCurrentnessEvidence.Service.readCurrent = () => Effect.succeed(input),
) =>
  availabilityCurrentnessService(request).pipe(
    Effect.provide(
      Layer.mergeAll(
        availabilityCurrentnessOwnerLayer,
        Layer.succeed(AvailabilityCurrentnessEvidence, { readCurrent }),
        Layer.succeed(AvailabilityOwnerValidityVerifier, { verify }),
      ),
    ),
  );
