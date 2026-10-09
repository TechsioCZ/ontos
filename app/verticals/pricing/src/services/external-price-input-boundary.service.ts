import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import type { PriceDefinition, PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import {
  PriceSourceAuthoritySchema,
  PriceSourceMappingSchema,
} from '@app/pricing-contracts/domain/price-source-provenance';
import type {
  PriceSourceAssertionAssessment,
  PriceSourceAssertionInput,
} from '@app/pricing-contracts/domain/price-source-provenance';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';

import { preparePriceSourceEvidence } from './price-source-provenance.service.ts';
import type { PreparedPriceSourceEvidence } from './price-source-provenance.service.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

/**
 * Pricing-owned proof that a source assertion is allowed to create one exact Price fact. The
 * transport/source-system identity is deliberately absent: delivery is not business authority.
 */
export const ExternalPriceSourceAuthorityGrantSchema = Schema.Struct({
  authority: PriceSourceAuthoritySchema,
  effectivePeriod: Schema.Struct({
    effectiveFrom: PricingInstantSchema,
    effectiveTo: Schema.optionalKey(PricingInstantSchema),
  }),
  exactIdentityKey: PriceIdentityKeySchema,
  family: Schema.Literal('PRICE'),
  mapping: PriceSourceMappingSchema,
  ownerModuleId: Schema.Literal('commerce.pricing'),
  schemaVersion: Schema.Literal('1'),
  verificationRef: stableReference,
  verifiedAt: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ effectivePeriod }) =>
    effectivePeriod.effectiveTo === undefined || effectivePeriod.effectiveFrom < effectivePeriod.effectiveTo
      ? undefined
      : 'Source Authority grant end must be after its start',
  ),
);
export type ExternalPriceSourceAuthorityGrant = typeof ExternalPriceSourceAuthorityGrantSchema.Type;

export interface ExternalPriceSourceAuthorityAssessmentRequest {
  readonly exactIdentityKey: PriceIdentityKey;
  readonly sourceAssertion: PriceSourceAssertionInput;
  readonly tenantId: string;
  readonly trustedOperationAt: Date;
}

export type ExternalPriceSourceAuthorityAssessment =
  | { readonly grant: ExternalPriceSourceAuthorityGrant; readonly outcome: 'AUTHORITY_GRANTED' }
  | { readonly outcome: 'AUTHORITY_REJECTED'; readonly reason: 'AUTHORITY' | 'MAPPING' }
  | { readonly outcome: 'AUTHORITY_UNRESOLVED'; readonly reason: 'AUTHORITY' | 'MAPPING' }
  | { readonly dependency: 'MAPPING_REGISTRY' | 'SOURCE_AUTHORITY'; readonly outcome: 'AUTHORITY_UNAVAILABLE' };

export interface ExternalPriceSourceAuthorityPort {
  readonly assess: (
    request: ExternalPriceSourceAuthorityAssessmentRequest,
  ) => Effect.Effect<ExternalPriceSourceAuthorityAssessment>;
}

export class ExternalPriceSourceAuthority extends Context.Service<
  ExternalPriceSourceAuthority,
  ExternalPriceSourceAuthorityPort
>()('@app/pricing/services/external-price-input-boundary.service/ExternalPriceSourceAuthority') {}

export interface ExternalPriceInputBoundaryRequest {
  readonly actingPrincipalId: string;
  readonly effectiveFrom: string;
  readonly identityKey: PriceIdentityKey;
  readonly monetaryAmount: PriceDefinition['revision']['monetaryAmount'];
  readonly sourceAssertion: PriceSourceAssertionInput;
  readonly tenantId: string;
  readonly trustedOperationAt: Date;
}

export interface ExternalPriceInputBoundaryService {
  readonly assess: (request: ExternalPriceInputBoundaryRequest) => Effect.Effect<ExternalPriceInputBoundaryAssessment>;
}

export type ExternalPriceInputBoundaryAssessment =
  | Exclude<PriceSourceAssertionAssessment, { readonly outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED' }>
  | PreparedPriceSourceEvidence;

export class ExternalPriceInputBoundary extends Context.Service<
  ExternalPriceInputBoundary,
  ExternalPriceInputBoundaryService
>()('@app/pricing/services/external-price-input-boundary.service/ExternalPriceInputBoundary') {}

export interface ExternalPriceInputBoundaryFactoryService {
  readonly make: (authority: ExternalPriceSourceAuthorityPort) => ExternalPriceInputBoundaryService;
}

/** Owner-local factory for transaction-scoped source-authority ports. */
export class ExternalPriceInputBoundaryFactory extends Context.Service<
  ExternalPriceInputBoundaryFactory,
  ExternalPriceInputBoundaryFactoryService
>()('@app/pricing/services/external-price-input-boundary.service/ExternalPriceInputBoundaryFactory') {}

const exactIdentityEquals = Schema.toEquivalence(PriceIdentityKeySchema);

type InvalidAssessment = Extract<
  PriceSourceAssertionAssessment,
  { readonly outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID' }
>;
type HeldAssessment = Extract<
  PriceSourceAssertionAssessment,
  { readonly outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD' }
>;
type UnavailableAssessment = Extract<
  PriceSourceAssertionAssessment,
  { readonly outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE' }
>;

const invalid = (
  sourceAssertion: PriceSourceAssertionInput,
  reason: 'MAPPING_REJECTED' | 'SOURCE_AUTHORITY_REJECTED',
): InvalidAssessment => ({
  outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
  reason,
  sourceAssertionId: sourceAssertion.sourceAssertionId,
});

const held = (
  sourceAssertion: PriceSourceAssertionInput,
  reason: 'MAPPING_UNRESOLVED' | 'SOURCE_AUTHORITY_UNRESOLVED',
): HeldAssessment => ({
  outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
  reason,
  sourceAssertionId: sourceAssertion.sourceAssertionId,
});

const unavailable = (
  sourceAssertion: PriceSourceAssertionInput,
  dependency: 'MAPPING_REGISTRY' | 'SOURCE_AUTHORITY',
): UnavailableAssessment => ({
  dependency,
  outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE',
  retryable: true,
  sourceAssertionId: sourceAssertion.sourceAssertionId,
});

const grantMatchesRequest = (
  grant: ExternalPriceSourceAuthorityGrant,
  request: ExternalPriceInputBoundaryRequest,
): 'AUTHORITY_MISMATCH' | 'MATCH' | 'MAPPING_MISMATCH' => {
  const { sourceAssertion } = request;
  if (
    grant.authority.sourceAuthorityRef !== sourceAssertion.sourceAuthority.sourceAuthorityRef ||
    grant.authority.sourceAuthorityVersion !== sourceAssertion.sourceAuthority.sourceAuthorityVersion ||
    grant.ownerModuleId !== 'commerce.pricing' ||
    grant.family !== 'PRICE'
  ) {
    return 'AUTHORITY_MISMATCH';
  }
  if (
    grant.mapping.mappingContractRef !== sourceAssertion.mapping.mappingContractRef ||
    grant.mapping.mappingContractVersion !== sourceAssertion.mapping.mappingContractVersion ||
    !exactIdentityEquals(grant.exactIdentityKey, request.identityKey) ||
    request.identityKey.catalogSelection.productRef.tenantId !== request.tenantId ||
    request.identityKey.catalogSelection.variantRef.tenantId !== request.tenantId ||
    request.identityKey.unitBasis.unitRef.tenantId !== request.tenantId
  ) {
    return 'MAPPING_MISMATCH';
  }
  const effectiveAt = sourceAssertion.timing.ownerBusinessEffectiveAt;
  return grant.effectivePeriod.effectiveFrom <= effectiveAt &&
    (grant.effectivePeriod.effectiveTo === undefined || effectiveAt < grant.effectivePeriod.effectiveTo) &&
    grant.verifiedAt <= DateTime.formatIso(DateTime.makeUnsafe(request.trustedOperationAt))
    ? 'MATCH'
    : 'AUTHORITY_MISMATCH';
};

/**
 * Accepts an external assertion only after Pricing verifies a versioned authority and mapping
 * grant for the exact canonical key. It does not fetch, normalize, or poll any external system.
 */
export const makeExternalPriceInputBoundary = (
  authority: ExternalPriceSourceAuthorityPort,
): ExternalPriceInputBoundaryService => ({
  assess: Effect.fn('ExternalPriceInputBoundary.assess')(function* assessExternalPriceInput(request) {
    const assessment = yield* authority.assess({
      exactIdentityKey: request.identityKey,
      sourceAssertion: request.sourceAssertion,
      tenantId: request.tenantId,
      trustedOperationAt: request.trustedOperationAt,
    });
    if (assessment.outcome === 'AUTHORITY_REJECTED') {
      return invalid(
        request.sourceAssertion,
        assessment.reason === 'AUTHORITY' ? 'SOURCE_AUTHORITY_REJECTED' : 'MAPPING_REJECTED',
      );
    }
    if (assessment.outcome === 'AUTHORITY_UNRESOLVED') {
      return held(
        request.sourceAssertion,
        assessment.reason === 'AUTHORITY' ? 'SOURCE_AUTHORITY_UNRESOLVED' : 'MAPPING_UNRESOLVED',
      );
    }
    if (assessment.outcome === 'AUTHORITY_UNAVAILABLE') {
      return unavailable(request.sourceAssertion, assessment.dependency);
    }
    if (!Schema.is(ExternalPriceSourceAuthorityGrantSchema)(assessment.grant)) {
      return unavailable(request.sourceAssertion, 'SOURCE_AUTHORITY');
    }
    const match = grantMatchesRequest(assessment.grant, request);
    if (match !== 'MATCH') {
      return invalid(
        request.sourceAssertion,
        match === 'AUTHORITY_MISMATCH' ? 'SOURCE_AUTHORITY_REJECTED' : 'MAPPING_REJECTED',
      );
    }
    return preparePriceSourceEvidence(request);
  }),
});

export const ExternalPriceInputBoundaryFactoryLive = Layer.succeed(
  ExternalPriceInputBoundaryFactory,
  Object.freeze({ make: makeExternalPriceInputBoundary }),
);

/** Production composition acquires the single configured Pricing-owned authority port. */
export const ExternalPriceInputBoundaryLive = Layer.effect(
  ExternalPriceInputBoundary,
  ExternalPriceSourceAuthority.pipe(Effect.map(makeExternalPriceInputBoundary)),
);
