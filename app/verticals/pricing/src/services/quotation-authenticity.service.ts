import { PricingQuotationAuthenticityVerificationEvidenceSchema } from '@app/pricing-contracts/domain/quotation';
import type {
  PricingQuotationAuthenticityInvalidReason,
  PricingQuotationAuthenticityUnverifiableReason,
  PricingQuotationAuthenticityVerificationEvidence,
  PricingQuotationIssued,
} from '@app/pricing-contracts/domain/quotation';
import { Context, Data, Effect, Match, Option, Schema } from 'effect';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

const PricingQuotationOwnerAuthenticSchema = Schema.TaggedStruct('VERIFIED', {
  evidence: PricingQuotationAuthenticityVerificationEvidenceSchema,
});

const PricingQuotationOwnerInvalidSchema = Schema.TaggedStruct('INVALID', {
  quotationRef: stableReference,
  reason: Schema.Literals(['INVALID_PROOF', 'PAYLOAD_TAMPERED']),
});

const PricingQuotationOwnerUnverifiableSchema = Schema.TaggedStruct('UNVERIFIABLE', {
  quotationRef: stableReference,
  reason: Schema.Literals([
    'DEPENDENCY_UNAVAILABLE',
    'LINEAGE_UNVERIFIABLE',
    'MISSING_PROOF',
    'RETIRED_KEY_WITHOUT_LINEAGE',
    'UNKNOWN_KEY',
    'UNSUPPORTED_KEY_VERSION',
  ]),
  retryable: Schema.Boolean,
}).check(
  Schema.makeFilter(({ reason, retryable }) =>
    retryable === (reason === 'DEPENDENCY_UNAVAILABLE')
      ? undefined
      : 'Only an unavailable authenticity dependency is retryable',
  ),
);

const PricingQuotationOwnerAuthenticityOutcomeSchema = Schema.Union([
  PricingQuotationOwnerAuthenticSchema,
  PricingQuotationOwnerInvalidSchema,
  PricingQuotationOwnerUnverifiableSchema,
]);
export type PricingQuotationOwnerAuthenticityOutcome = typeof PricingQuotationOwnerAuthenticityOutcomeSchema.Type;

export class PricingQuotationAuthenticityProviderUnavailable extends Data.TaggedError(
  'PricingQuotationAuthenticityProviderUnavailable',
)<{
  readonly cause?: unknown;
  readonly reason: 'VERIFICATION_DEPENDENCY_UNAVAILABLE';
}> {}

/**
 * Input to the owner-private proof verifier. The verifier loads proof and key material privately;
 * callers can provide neither. `immutablePayload` includes the original quoted source evidence.
 */
export interface PricingQuotationAuthenticityVerificationInput {
  readonly immutablePayload: {
    readonly binding: PricingQuotationIssued['binding'];
    readonly materialEvidence: PricingQuotationIssued['materialEvidence'];
    readonly quotedResult: PricingQuotationIssued['quotedResult'];
    readonly validity: PricingQuotationIssued['validity'];
  };
  readonly quotationIdentity: {
    readonly issuedAt: PricingQuotationIssued['issuedAt'];
    readonly kind: PricingQuotationIssued['kind'];
    readonly quotationRef: PricingQuotationIssued['quotationRef'];
  };
}

/**
 * Owner-private cryptographic boundary. Its implementation resolves the stored proof and exact
 * key version/lineage, then verifies the canonical immutable quotation payload. A historical key
 * remains valid when its retained version and lineage are verifiable.
 */
export interface PricingQuotationAuthenticityVerifierService {
  readonly verifyImmutableQuotation: (
    input: PricingQuotationAuthenticityVerificationInput,
  ) => Effect.Effect<unknown, PricingQuotationAuthenticityProviderUnavailable>;
}

export class PricingQuotationAuthenticityVerifier extends Context.Service<
  PricingQuotationAuthenticityVerifier,
  PricingQuotationAuthenticityVerifierService
>()('@app/pricing/services/quotation-authenticity.service/PricingQuotationAuthenticityVerifier') {}

export type PricingQuotationAuthenticityOutcome =
  | {
      readonly evidence: PricingQuotationAuthenticityVerificationEvidence;
      readonly kind: 'QUOTATION_AUTHENTIC';
    }
  | {
      readonly kind: 'QUOTATION_AUTHENTICITY_INVALID';
      readonly quotationRef: string;
      readonly reason: PricingQuotationAuthenticityInvalidReason;
    }
  | {
      readonly kind: 'QUOTATION_AUTHENTICITY_UNVERIFIABLE';
      readonly quotationRef: string;
      readonly reason: PricingQuotationAuthenticityUnverifiableReason;
      readonly retryable: boolean;
    };

export interface PricingQuotationAuthenticityService {
  readonly verify: (input: {
    readonly quotation: PricingQuotationIssued;
  }) => Effect.Effect<PricingQuotationAuthenticityOutcome>;
}

class PricingQuotationAuthenticity extends Context.Service<
  PricingQuotationAuthenticity,
  PricingQuotationAuthenticityService
>()('@app/pricing/services/quotation-authenticity.service/PricingQuotationAuthenticity') {}

const dependencyUnavailable = (quotationRef: string): PricingQuotationAuthenticityOutcome => ({
  kind: 'QUOTATION_AUTHENTICITY_UNVERIFIABLE',
  quotationRef,
  reason: 'DEPENDENCY_UNAVAILABLE',
  retryable: true,
});

/**
 * Verifies authenticity only. It performs no Current reads, repricing, expiry decision, scope
 * rebinding, ordinary revocation, or Commitment Confirmation issuance.
 */
export const makePricingQuotationAuthenticityService = Effect.gen(function* makePricingQuotationAuthenticityService() {
  const verifier = yield* PricingQuotationAuthenticityVerifier;
  return {
    verify: Effect.fn('PricingQuotationAuthenticity.verify')(function* verifyPricingQuotationAuthenticity({
      quotation,
    }: {
      readonly quotation: PricingQuotationIssued;
    }) {
      const ownerResultRead = yield* verifier
        .verifyImmutableQuotation({
          immutablePayload: {
            binding: quotation.binding,
            materialEvidence: quotation.materialEvidence,
            quotedResult: quotation.quotedResult,
            validity: quotation.validity,
          },
          quotationIdentity: {
            issuedAt: quotation.issuedAt,
            kind: quotation.kind,
            quotationRef: quotation.quotationRef,
          },
        })
        .pipe(
          Effect.match({
            onFailure: (failure) => ({ failure, kind: 'failure' as const }),
            onSuccess: (value) => ({ kind: 'success' as const, value }),
          }),
        );
      if (ownerResultRead.kind === 'failure') {
        return dependencyUnavailable(quotation.quotationRef);
      }

      const ownerResult = Schema.decodeUnknownOption(PricingQuotationOwnerAuthenticityOutcomeSchema, {
        onExcessProperty: 'error',
      })(ownerResultRead.value);
      if (Option.isNone(ownerResult)) {
        return dependencyUnavailable(quotation.quotationRef);
      }

      return Match.value(ownerResult.value).pipe(
        Match.tag('VERIFIED', (verified) =>
          verified.evidence.quotationRef === quotation.quotationRef
            ? { evidence: verified.evidence, kind: 'QUOTATION_AUTHENTIC' as const }
            : {
                kind: 'QUOTATION_AUTHENTICITY_INVALID' as const,
                quotationRef: quotation.quotationRef,
                reason: 'INVALID_PROOF' as const,
              },
        ),
        Match.tag('INVALID', (invalid) =>
          invalid.quotationRef === quotation.quotationRef
            ? {
                kind: 'QUOTATION_AUTHENTICITY_INVALID' as const,
                quotationRef: quotation.quotationRef,
                reason: invalid.reason,
              }
            : {
                kind: 'QUOTATION_AUTHENTICITY_INVALID' as const,
                quotationRef: quotation.quotationRef,
                reason: 'INVALID_PROOF' as const,
              },
        ),
        Match.tag('UNVERIFIABLE', (unverifiable) =>
          unverifiable.quotationRef === quotation.quotationRef
            ? {
                kind: 'QUOTATION_AUTHENTICITY_UNVERIFIABLE' as const,
                quotationRef: quotation.quotationRef,
                reason: unverifiable.reason,
                retryable: unverifiable.retryable,
              }
            : {
                kind: 'QUOTATION_AUTHENTICITY_INVALID' as const,
                quotationRef: quotation.quotationRef,
                reason: 'INVALID_PROOF' as const,
              },
        ),
        Match.exhaustive,
      );
    }),
  } satisfies typeof PricingQuotationAuthenticity.Service;
});
