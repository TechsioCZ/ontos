import {
  PricingQuotationIssuanceRequestSchema,
  PricingQuotationIssuedSchema,
  PricingQuotationValidityPolicyEvidenceSchema,
  PricingQuotationValiditySchema,
} from '@app/pricing-contracts/domain/quotation';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import type {
  PricingQuotationBinding,
  PricingQuotationIssuanceRequest,
  PricingQuotationIssued,
  PricingQuotationValidityPolicyEvidence,
  PricingRetainedDisplayOnlyResult,
} from '@app/pricing-contracts/domain/quotation';
import { Context, Data, DateTime, Effect, Option, Schema } from 'effect';

import { PricingQuotationIssuanceUnavailable } from './quotation-issuance-unavailable.ts';

export { PricingQuotationIssuanceUnavailable } from './quotation-issuance-unavailable.ts';

export class PricingQuotationIssuanceRejected extends Data.TaggedError('PricingQuotationIssuanceRejected')<{
  readonly cause?: unknown;
  readonly reason:
    | 'AUTHORITY_BINDING_REJECTED'
    | 'CURRENT_RESULT_NOT_FRESH'
    | 'INVALID_ISSUANCE_REQUEST'
    | 'INVALID_VALIDITY_POLICY';
}> {}

export type PricingQuotationIssuanceCandidate = PricingQuotationIssuanceRequest | PricingRetainedDisplayOnlyResult;

export interface PricingQuotationReferenceIssuer {
  /** Owner-private source. A quotation reference is never accepted from the issuance request. */
  readonly issueReference: (input: {
    readonly candidateRef: string;
    readonly issuedAt: string;
    readonly tenantId: string;
  }) => Effect.Effect<string, PricingQuotationIssuanceUnavailable>;
}

export interface PricingQuotationTrustedOperationTime {
  /** Owner-private trusted time. Public quotation input cannot supply or override this instant. */
  readonly readOperationTime: Effect.Effect<string, PricingQuotationIssuanceUnavailable>;
}

/**
 * Owner-private authority seam. Implementations resolve the actual authenticated subject or the
 * owner-issued Guest Purchase Context from trusted backend state and compare it with this exact
 * immutable binding. Schema-valid references alone are never authority.
 */
export interface PricingQuotationIssuanceAuthority {
  readonly verifyIssuanceAuthority: (input: {
    readonly binding: PricingQuotationBinding;
    readonly operationTime: typeof PricingInstantSchema.Type;
  }) => Effect.Effect<void, PricingQuotationIssuanceRejected | PricingQuotationIssuanceUnavailable>;
}

export interface PricingQuotationValidityPolicyDecision {
  readonly durationMilliseconds: number;
  readonly policyEvidence: PricingQuotationValidityPolicyEvidence;
}

/** Owner-private capability. A browser cannot select or extend a quotation validity interval. */
export interface PricingQuotationValidityPolicy {
  readonly selectValidity: (input: {
    readonly binding: PricingQuotationBinding;
    readonly quotedResult: PricingQuotationIssued['quotedResult'];
    readonly validFrom: typeof PricingInstantSchema.Type;
  }) => Effect.Effect<
    PricingQuotationValidityPolicyDecision,
    PricingQuotationIssuanceRejected | PricingQuotationIssuanceUnavailable
  >;
}

export interface PricingQuotationIssuanceService {
  readonly issue: (
    request: PricingQuotationIssuanceCandidate,
  ) => Effect.Effect<PricingQuotationIssued, PricingQuotationIssuanceRejected | PricingQuotationIssuanceUnavailable>;
}

export interface PricingQuotationOwnerIssuanceBoundary
  extends PricingQuotationIssuanceAuthority, PricingQuotationReferenceIssuer, PricingQuotationValidityPolicy {}

export class PricingQuotationIssuance extends Context.Service<
  PricingQuotationIssuance,
  PricingQuotationIssuanceService
>()('@app/pricing/services/quotation-issuance.service/PricingQuotationIssuance') {}

const reject = (reason: PricingQuotationIssuanceRejected['reason']) => new PricingQuotationIssuanceRejected({ reason });

/**
 * Explicit owner boundary for turning one fresh complete Current result into an immutable quote.
 * It performs no Current read, retained-value promotion, ordinary repricing, validity revalidation,
 * candidate rebinding, quotation extension, or Commitment Confirmation issuance.
 */
export const makePricingQuotationIssuanceService = (
  ownerBoundary: PricingQuotationOwnerIssuanceBoundary,
  trustedTime: PricingQuotationTrustedOperationTime,
): PricingQuotationIssuanceService => ({
  issue: Effect.fn('PricingQuotationIssuance.issue')(function* issuePricingQuotation(input) {
    const requestOption = Schema.decodeOption(PricingQuotationIssuanceRequestSchema, {
      onExcessProperty: 'error',
    })(input);
    if (Option.isNone(requestOption)) {
      return yield* reject('INVALID_ISSUANCE_REQUEST');
    }
    const request = requestOption.value;
    const { commercialTotal } = request.currentResult;
    const trustedOperationTimeRaw = yield* trustedTime.readOperationTime;
    const trustedOperationTimeOption = Schema.decodeOption(PricingInstantSchema)(trustedOperationTimeRaw);
    if (Option.isNone(trustedOperationTimeOption)) {
      return yield* new PricingQuotationIssuanceUnavailable({
        reason: 'TRUSTED_OPERATION_TIME_UNAVAILABLE',
        retryable: true,
      });
    }
    const trustedOperationTime = trustedOperationTimeOption.value;

    // #784 owns trusted-clock validity checks. #782 only permits issuance from the result evaluated
    // at this exact backend operation instant, never from an earlier retained Current read.
    if (commercialTotal.decision.operationTime !== trustedOperationTime) {
      return yield* reject('CURRENT_RESULT_NOT_FRESH');
    }
    if (request.materialEvidence.validatedAt > trustedOperationTime) {
      return yield* reject('INVALID_ISSUANCE_REQUEST');
    }

    // The decoded binding proves structural coherence with the Current result, but its subject,
    // Guest session, context, and evidence references remain caller claims until the owning
    // backend validates them against the actual operation authority.
    yield* ownerBoundary.verifyIssuanceAuthority({
      binding: request.binding,
      operationTime: trustedOperationTime,
    });

    const policy = yield* ownerBoundary.selectValidity({
      binding: request.binding,
      quotedResult: commercialTotal,
      validFrom: trustedOperationTime,
    });
    if (
      !Number.isSafeInteger(policy.durationMilliseconds) ||
      policy.durationMilliseconds <= 0 ||
      !Schema.is(PricingQuotationValidityPolicyEvidenceSchema)(policy.policyEvidence)
    ) {
      return yield* reject('INVALID_VALIDITY_POLICY');
    }
    if (policy.durationMilliseconds > policy.policyEvidence.maximumValidityDurationMilliseconds) {
      return yield* reject('INVALID_VALIDITY_POLICY');
    }
    const validUntil = yield* Effect.try({
      catch: (cause) => new PricingQuotationIssuanceRejected({ cause, reason: 'INVALID_VALIDITY_POLICY' }),
      try: () =>
        DateTime.makeUnsafe(trustedOperationTime).pipe(
          DateTime.add({ milliseconds: policy.durationMilliseconds }),
          DateTime.formatIso,
        ),
    });
    const validityOption = Schema.decodeOption(PricingQuotationValiditySchema, {
      onExcessProperty: 'error',
    })({
      policyEvidence: policy.policyEvidence,
      validFrom: trustedOperationTime,
      validUntil,
    });
    if (Option.isNone(validityOption)) {
      return yield* reject('INVALID_VALIDITY_POLICY');
    }

    const quotationRef = yield* ownerBoundary.issueReference({
      candidateRef: commercialTotal.candidateRef,
      issuedAt: trustedOperationTime,
      tenantId: commercialTotal.decision.tenantId,
    });
    const issuedOption = Schema.decodeOption(PricingQuotationIssuedSchema, {
      onExcessProperty: 'error',
    })({
      binding: request.binding,
      issuedAt: trustedOperationTime,
      kind: 'PRICING_QUOTATION',
      materialEvidence: request.materialEvidence,
      quotationRef,
      quotedResult: commercialTotal,
      validity: validityOption.value,
    });
    if (Option.isNone(issuedOption)) {
      return yield* new PricingQuotationIssuanceUnavailable({
        reason: 'REFERENCE_ISSUANCE_UNAVAILABLE',
        retryable: true,
      });
    }
    return issuedOption.value;
  }),
});
