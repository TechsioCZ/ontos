import type {
  PriceGroupAssignmentProfile,
  PriceGroupAssignmentResolution,
  PriceGroupAssignmentResolutionRequest,
  PriceGroupAssignmentResolutionResponse,
  PriceGroupInterpretation,
  PriceGroupInterpretationBasis,
  PriceGroupInterpretationUnverifiableReason,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import {
  PriceGroupInterpretationAssignmentRequestSchema,
  PriceGroupInterpretationDependencyOwnerSchema,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import type {
  PriceGroupCompatibilityDecision,
  PriceGroupCompatibilityEvidence,
} from '@app/price-group-catalog-contracts/price-group';
import type { ValidatePriceGroupCompatibilityRequest } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import { Context, Effect, Match, Option, Schema } from 'effect';

export class PriceGroupInterpretationDependencyFailure extends Schema.TaggedError<PriceGroupInterpretationDependencyFailure>()(
  'PriceGroupInterpretationDependencyFailure',
  {
    kind: Schema.Literals(['UNAVAILABLE', 'UNVERIFIABLE']),
    owner: PriceGroupInterpretationDependencyOwnerSchema,
    reason: Schema.String,
  },
) {}

interface CommercePriceGroupResolutionInput {
  readonly request: PriceGroupAssignmentResolutionRequest;
  readonly sellingLegalEntityId: PriceGroupInterpretationBasis['commercialScope']['sellingLegalEntityId'];
}

export interface CommercePriceGroupResolutionPort {
  readonly resolve: (
    input: CommercePriceGroupResolutionInput,
  ) => Effect.Effect<PriceGroupAssignmentResolutionResponse, PriceGroupInterpretationDependencyFailure>;
}

class CommercePriceGroupResolution extends Context.Service<
  CommercePriceGroupResolution,
  CommercePriceGroupResolutionPort
>()('@app/pricing/services/price-group-interpretation.service/CommercePriceGroupResolution') {}

export interface PriceGroupCompatibilityPort {
  readonly validate: (
    request: ValidatePriceGroupCompatibilityRequest,
  ) => Effect.Effect<PriceGroupCompatibilityDecision, PriceGroupInterpretationDependencyFailure>;
}

class PriceGroupCompatibility extends Context.Service<PriceGroupCompatibility, PriceGroupCompatibilityPort>()(
  '@app/pricing/services/price-group-interpretation.service/PriceGroupCompatibility',
) {}

interface PriceGroupInterpretationDependencies {
  readonly commerce: CommercePriceGroupResolutionPort;
  readonly compatibility: PriceGroupCompatibilityPort;
}

interface PriceGroupInterpretationRuntimeInput {
  readonly assignmentRequest: unknown;
  readonly basis: PriceGroupInterpretationBasis;
}

export interface PriceGroupInterpretationService {
  readonly interpret: (input: PriceGroupInterpretationRuntimeInput) => Effect.Effect<PriceGroupInterpretation>;
}

class PriceGroupInterpreter extends Context.Service<PriceGroupInterpreter, PriceGroupInterpretationService>()(
  '@app/pricing/services/price-group-interpretation.service/PriceGroupInterpreter',
) {}

interface ResourceReference {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

const sameReference = (left: ResourceReference, right: ResourceReference): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameProfile = (left: PriceGroupAssignmentProfile, right: PriceGroupAssignmentProfile): boolean =>
  left.kind === right.kind && sameReference(left, right);

const sameCompatibilityMaterial = (
  expected: PriceGroupCompatibilityEvidence,
  actual: PriceGroupCompatibilityEvidence,
): boolean =>
  expected.catalogRevision === actual.catalogRevision &&
  expected.definitionRevisionId === actual.definitionRevisionId &&
  expected.definitionRevisionNumber === actual.definitionRevisionNumber &&
  expected.meaningFingerprint === actual.meaningFingerprint &&
  expected.definitionEffectivePeriod.effectiveFrom === actual.definitionEffectivePeriod.effectiveFrom &&
  expected.definitionEffectivePeriod.effectiveTo === actual.definitionEffectivePeriod.effectiveTo &&
  expected.requiredContract.contractId === actual.requiredContract.contractId &&
  expected.requiredContract.version === actual.requiredContract.version &&
  expected.trustedOperationAt === actual.trustedOperationAt &&
  sameReference(expected.priceGroupRef, actual.priceGroupRef);

const expectedCurrent = (evidence: PriceGroupCompatibilityEvidence) => ({
  catalogRevision: evidence.catalogRevision,
  definitionRevisionId: evidence.definitionRevisionId,
  definitionRevisionNumber: evidence.definitionRevisionNumber,
  meaningFingerprint: evidence.meaningFingerprint,
  priceGroupRef: evidence.priceGroupRef,
});

const unavailable = (
  basis: PriceGroupInterpretationBasis,
  failure: PriceGroupInterpretationDependencyFailure,
): PriceGroupInterpretation =>
  failure.kind === 'UNAVAILABLE'
    ? { _tag: 'UNAVAILABLE', basis, owner: failure.owner, reason: failure.reason }
    : {
        _tag: 'UNVERIFIABLE',
        basis,
        owner: failure.owner,
        reason: 'DEPENDENCY_EVIDENCE_UNVERIFIABLE',
      };

const unverifiable = (
  basis: PriceGroupInterpretationBasis,
  owner: PriceGroupInterpretationDependencyFailure['owner'],
  reason: PriceGroupInterpretationUnverifiableReason,
): PriceGroupInterpretation => ({ _tag: 'UNVERIFIABLE', basis, owner, reason });

const decisionBindsAssignment = (
  decision: Exclude<PriceGroupCompatibilityDecision, { readonly kind: 'USABLE' }>,
  priceGroupRef: ResourceReference,
  effectiveAt: string,
): boolean => {
  if (decision.kind === 'MISSING') {
    return (
      sameReference(decision.priceGroupRef, priceGroupRef) &&
      decision.catalogObservation.trustedOperationAt === effectiveAt
    );
  }
  return (
    sameReference(decision.evidence.priceGroupRef, priceGroupRef) &&
    decision.evidence.trustedOperationAt === effectiveAt
  );
};

type AssignedResolution = Extract<PriceGroupAssignmentResolution, { readonly _tag: 'ASSIGNED' }>;

const interpretAssignedResolution = Effect.fn('PriceGroupInterpretation.interpretAssignedResolution')(
  function* interpretAssigned(
    basis: PriceGroupInterpretationBasis,
    response: PriceGroupAssignmentResolutionResponse,
    resolution: AssignedResolution,
    compatibility: PriceGroupCompatibilityPort,
  ) {
    if (
      resolution.assignmentRef.tenantId !== response.profile.tenantId ||
      resolution.priceGroupRef.tenantId !== response.profile.tenantId
    ) {
      return unverifiable(basis, 'COMMERCE_ASSIGNMENT', 'ASSIGNMENT_SCOPE_MISMATCH');
    }
    const evidence = resolution.compatibility;
    const assignmentIsCurrent =
      resolution.effectiveFrom <= response.effectiveAt &&
      (resolution.effectiveTo === null || response.effectiveAt < resolution.effectiveTo);
    if (!assignmentIsCurrent || evidence.trustedOperationAt !== response.effectiveAt) {
      return unverifiable(basis, 'COMMERCE_ASSIGNMENT', 'ASSIGNMENT_TIME_MISMATCH');
    }
    if (!sameReference(evidence.priceGroupRef, resolution.priceGroupRef)) {
      return unverifiable(basis, 'COMMERCE_ASSIGNMENT', 'COMPATIBILITY_EVIDENCE_MISMATCH');
    }

    const validationRequest: ValidatePriceGroupCompatibilityRequest = {
      expectedCurrent: expectedCurrent(evidence),
      priceGroupRef: resolution.priceGroupRef,
      requiredContract: evidence.requiredContract,
      trustedOperationAt: response.effectiveAt,
    };
    const validation = yield* compatibility.validate(validationRequest).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure, kind: 'FAILURE' as const }),
        onSuccess: (decision) => ({ decision, kind: 'SUCCESS' as const }),
      }),
    );
    if (validation.kind === 'FAILURE') {
      return unavailable(basis, validation.failure);
    }

    const { decision } = validation;
    if (decision.kind !== 'USABLE') {
      if (!decisionBindsAssignment(decision, resolution.priceGroupRef, response.effectiveAt)) {
        return unverifiable(basis, 'PRICE_GROUP_COMPATIBILITY', 'COMPATIBILITY_EVIDENCE_MISMATCH');
      }
      return {
        _tag: 'BROKEN',
        assignmentResolution: resolution,
        basis,
        compatibilityDecision: decision,
        reason: decision.kind,
        source: 'PRICE_GROUP_COMPATIBILITY',
      } satisfies PriceGroupInterpretation;
    }
    if (!sameCompatibilityMaterial(evidence, decision.evidence)) {
      return unverifiable(basis, 'PRICE_GROUP_COMPATIBILITY', 'COMPATIBILITY_EVIDENCE_MISMATCH');
    }
    return {
      _tag: 'ASSIGNED',
      assignmentResolution: resolution,
      basis,
      compatibilityEvidence: decision.evidence,
      discountAudience: { kind: 'PRICE_GROUP', priceGroupRef: resolution.priceGroupRef },
      priceGroupRef: resolution.priceGroupRef,
      priceSelector: { kind: 'PRICE_GROUP', priceGroupRef: resolution.priceGroupRef },
    } satisfies PriceGroupInterpretation;
  },
);

const interpretOwnerResponse = Effect.fn('PriceGroupInterpretation.interpretOwnerResponse')(function* interpret(
  basis: PriceGroupInterpretationBasis,
  request: PriceGroupAssignmentResolutionRequest,
  response: PriceGroupAssignmentResolutionResponse,
  compatibility: PriceGroupCompatibilityPort,
) {
  if (request.effectiveAt !== response.effectiveAt) {
    return unverifiable(basis, 'COMMERCE_ASSIGNMENT', 'ASSIGNMENT_TIME_MISMATCH');
  }
  if (!sameProfile(request.profile, response.profile)) {
    return unverifiable(basis, 'COMMERCE_ASSIGNMENT', 'ASSIGNMENT_PROFILE_MISMATCH');
  }
  if (response.profile.tenantId !== basis.catalogSelection.productRef.tenantId) {
    return unverifiable(basis, 'COMMERCE_ASSIGNMENT', 'ASSIGNMENT_SCOPE_MISMATCH');
  }

  return yield* Match.value(response.resolution).pipe(
    Match.tag('NONE', (resolution) =>
      Effect.succeed({
        _tag: 'NONE' as const,
        assignmentResolution: resolution,
        basis,
        discountAudience: { kind: 'NONE' as const },
        priceSelector: { kind: 'NO_GROUP' as const },
      }),
    ),
    Match.tag('INCONSISTENT', (resolution) =>
      Effect.succeed({
        _tag: 'INCONSISTENT' as const,
        assignmentResolution: resolution,
        basis,
        currentAssignmentCount: resolution.currentAssignmentCount,
      }),
    ),
    Match.tag('BROKEN', (resolution) =>
      resolution.assignmentRef.tenantId !== response.profile.tenantId ||
      resolution.priceGroupRef.tenantId !== response.profile.tenantId
        ? Effect.succeed(unverifiable(basis, 'COMMERCE_ASSIGNMENT', 'ASSIGNMENT_SCOPE_MISMATCH'))
        : Effect.succeed({
            _tag: 'BROKEN' as const,
            assignmentResolution: resolution,
            basis,
            reason: resolution.reason,
            source: 'COMMERCE_ASSIGNMENT' as const,
          }),
    ),
    Match.tag('ASSIGNED', (resolution) => interpretAssignedResolution(basis, response, resolution, compatibility)),
    Match.exhaustive,
  );
});

export const makePriceGroupInterpretationService = (
  dependencies: PriceGroupInterpretationDependencies,
): PriceGroupInterpretationService => {
  const commerce = CommercePriceGroupResolution.of(dependencies.commerce);
  const compatibility = PriceGroupCompatibility.of(dependencies.compatibility);
  return PriceGroupInterpreter.of({
    interpret: Effect.fn('PriceGroupInterpretation.interpret')(function* interpret(input) {
      const decodedRequest = Schema.decodeUnknownOption(PriceGroupInterpretationAssignmentRequestSchema, {
        onExcessProperty: 'error',
      })(input.assignmentRequest);
      if (Option.isNone(decodedRequest)) {
        return unverifiable(input.basis, 'COMMERCE_ASSIGNMENT', 'DEPENDENCY_EVIDENCE_UNVERIFIABLE');
      }
      const assignmentRequest = decodedRequest.value;
      if ('kind' in assignmentRequest) {
        return {
          _tag: 'NONE',
          assignmentResolution: { _tag: 'NONE' },
          basis: input.basis,
          discountAudience: { kind: 'NONE' },
          priceSelector: { kind: 'NO_GROUP' },
        } satisfies PriceGroupInterpretation;
      }
      const commerceResult = yield* commerce
        .resolve({
          request: assignmentRequest,
          sellingLegalEntityId: input.basis.commercialScope.sellingLegalEntityId,
        })
        .pipe(
          Effect.match({
            onFailure: (failure) => ({ failure, kind: 'FAILURE' as const }),
            onSuccess: (response) => ({ kind: 'SUCCESS' as const, response }),
          }),
        );
      return commerceResult.kind === 'FAILURE'
        ? unavailable(input.basis, commerceResult.failure)
        : yield* interpretOwnerResponse(input.basis, assignmentRequest, commerceResult.response, compatibility);
    }),
  });
};
