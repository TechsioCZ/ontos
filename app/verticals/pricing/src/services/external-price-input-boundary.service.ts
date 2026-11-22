import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { PriceIdentityKeySchema, priceDecimalValuesEqual } from '@app/pricing-contracts/domain/price-definition';
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

import { ExternalPriceSourcePolicySchema } from '../../shared/domain/external-price-source-policy.ts';
import type { ExternalPriceSourcePolicy } from '../../shared/domain/external-price-source-policy.ts';

import { preparePriceSourceEvidence } from './price-source-provenance.service.ts';
import type { PreparedPriceSourceEvidence } from './price-source-provenance.service.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

// Assessments (including the projection of historical grant evidence) use native lowercase UUIDs.
const authorityIdentityKeySchema = PriceIdentityKeySchema.check(
  Schema.makeFilter(({ priceGroupSelector, unitBasis }) =>
    unitBasis.unitRef.resourceId === unitBasis.unitRef.resourceId.toLowerCase() &&
    (priceGroupSelector.kind === 'NO_GROUP' ||
      priceGroupSelector.priceGroupRef.resourceId === priceGroupSelector.priceGroupRef.resourceId.toLowerCase())
      ? undefined
      : 'External Price authority requires canonical lowercase Unit and Price Group IDs',
  ),
);

// PriceIdentityKeySchema requires every reference in the key to share the product Tenant.
export const priceAuthorityKeyInTenant = (key: PriceIdentityKey, tenantId: string): boolean =>
  Schema.is(authorityIdentityKeySchema)(key) && key.catalogSelection.productRef.tenantId === tenantId;

/**
 * Pricing-owned proof that a source assertion is allowed to create one exact Price fact. The
 * transport/source-system identity is deliberately absent: delivery is not business authority.
 */
export const ExternalPriceSourceAuthorityGrantInputSchema = Schema.Struct({
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
// Enrollment preserves the caller's UUID spelling for receipt replay. A resolved grant is always canonical.
export const ExternalPriceSourceAuthorityGrantSchema = ExternalPriceSourceAuthorityGrantInputSchema.check(
  Schema.makeFilter(({ exactIdentityKey }) =>
    Schema.is(authorityIdentityKeySchema)(exactIdentityKey) ? undefined : 'Expected a canonical grant identity',
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
  | { readonly outcome: 'AUTHORITY_COVERED_BY_POLICY'; readonly policy: ExternalPriceSourcePolicy }
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

const identityKeyEquivalence = Schema.toEquivalence(PriceIdentityKeySchema);
/**
 * The exact canonical key, with the unit quantity compared as the number it is. Pricing stores and reads a
 * quantity with nine decimals, so `"1"` and `"1.000000000"` name the same key. Every other part stays exact.
 */
const exactIdentityEquals = (grantKey: PriceIdentityKey, requestKey: PriceIdentityKey): boolean =>
  priceDecimalValuesEqual(grantKey.unitBasis.quantity, requestKey.unitBasis.quantity) &&
  identityKeyEquivalence(
    { ...grantKey, unitBasis: { ...grantKey.unitBasis, quantity: requestKey.unitBasis.quantity } },
    requestKey,
  );

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

const effectivePeriodAdmits = (
  effectivePeriod: ExternalPriceSourceAuthorityGrant['effectivePeriod'],
  verifiedAt: string,
  request: ExternalPriceInputBoundaryRequest,
): boolean => {
  const effectiveAt = request.sourceAssertion.timing.ownerBusinessEffectiveAt;
  return (
    effectivePeriod.effectiveFrom <= effectiveAt &&
    (effectivePeriod.effectiveTo === undefined || effectiveAt < effectivePeriod.effectiveTo) &&
    verifiedAt <= DateTime.formatIso(DateTime.makeUnsafe(request.trustedOperationAt))
  );
};

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
    !priceAuthorityKeyInTenant(request.identityKey, request.tenantId)
  ) {
    return 'MAPPING_MISMATCH';
  }
  return effectivePeriodAdmits(grant.effectivePeriod, grant.verifiedAt, request) ? 'MATCH' : 'AUTHORITY_MISMATCH';
};

const priceGroupCoverageAdmits = (
  coverage: ExternalPriceSourcePolicy['priceGroupCoverage'],
  selector: PriceIdentityKey['priceGroupSelector'],
): boolean => {
  if (coverage.kind === 'NO_GROUP') {
    return selector.kind === 'NO_GROUP';
  }
  if (selector.kind !== 'PRICE_GROUP') {
    return false;
  }
  return (
    coverage.kind === 'ANY_PRICE_GROUP' ||
    (coverage.priceGroupRef.resourceId === selector.priceGroupRef.resourceId &&
      coverage.priceGroupRef.tenantId === selector.priceGroupRef.tenantId)
  );
};

/**
 * A standing policy authorizes the exact key being written only when the key lies inside everything the policy
 * names: authority, mapping, commercial scope, currency, unit basis and Price Group coverage, at the asserted time.
 */
export const policyCoversRequest = (
  policy: ExternalPriceSourcePolicy,
  request: ExternalPriceInputBoundaryRequest,
): 'AUTHORITY_MISMATCH' | 'MATCH' | 'MAPPING_MISMATCH' => {
  const { identityKey, sourceAssertion } = request;
  if (
    policy.authority.sourceAuthorityRef !== sourceAssertion.sourceAuthority.sourceAuthorityRef ||
    policy.authority.sourceAuthorityVersion !== sourceAssertion.sourceAuthority.sourceAuthorityVersion
  ) {
    return 'AUTHORITY_MISMATCH';
  }
  const policyUnit = policy.unitBasis.unitRef;
  const keyUnit = identityKey.unitBasis.unitRef;
  if (
    policy.mapping.mappingContractRef !== sourceAssertion.mapping.mappingContractRef ||
    policy.mapping.mappingContractVersion !== sourceAssertion.mapping.mappingContractVersion ||
    policy.commercialScope.channelId !== identityKey.commercialScope.channelId ||
    policy.commercialScope.marketId !== identityKey.commercialScope.marketId ||
    policy.commercialScope.sellingLegalEntityId !== identityKey.commercialScope.sellingLegalEntityId ||
    policy.currencyCode !== identityKey.currencyCode ||
    !priceDecimalValuesEqual(policy.unitBasis.quantity, identityKey.unitBasis.quantity) ||
    policyUnit.moduleId !== keyUnit.moduleId ||
    policyUnit.resourceId !== keyUnit.resourceId ||
    policyUnit.resourceType !== keyUnit.resourceType ||
    policyUnit.tenantId !== keyUnit.tenantId ||
    !priceGroupCoverageAdmits(policy.priceGroupCoverage, identityKey.priceGroupSelector) ||
    !priceAuthorityKeyInTenant(request.identityKey, request.tenantId)
  ) {
    return 'MAPPING_MISMATCH';
  }
  return effectivePeriodAdmits(policy.effectivePeriod, policy.verifiedAt, request) ? 'MATCH' : 'AUTHORITY_MISMATCH';
};

/** Re-checks the owner's resolved authorization against the exact request before any evidence is prepared. */
const authorizationMatchesRequest = (
  assessment: Extract<
    ExternalPriceSourceAuthorityAssessment,
    { readonly outcome: 'AUTHORITY_COVERED_BY_POLICY' | 'AUTHORITY_GRANTED' }
  >,
  request: ExternalPriceInputBoundaryRequest,
): 'AUTHORITY_MISMATCH' | 'MATCH' | 'MAPPING_MISMATCH' | 'UNVERIFIABLE' => {
  if (assessment.outcome === 'AUTHORITY_GRANTED') {
    return Schema.is(ExternalPriceSourceAuthorityGrantSchema)(assessment.grant)
      ? grantMatchesRequest(assessment.grant, request)
      : 'UNVERIFIABLE';
  }
  return Schema.is(ExternalPriceSourcePolicySchema)(assessment.policy)
    ? policyCoversRequest(assessment.policy, request)
    : 'UNVERIFIABLE';
};

/**
 * Accepts an external assertion only after Pricing verifies a versioned authority and mapping for the exact
 * canonical key: an exact-key grant, or a standing source policy that covers the key. Authority never comes from
 * the incoming assertion. It does not fetch, normalize, or poll any external system.
 */
export const makeExternalPriceInputBoundary = (
  authority: ExternalPriceSourceAuthorityPort,
): ExternalPriceInputBoundaryService => ({
  assess: Effect.fn('ExternalPriceInputBoundary.assess')(function* assessExternalPriceInput(request) {
    if (!priceAuthorityKeyInTenant(request.identityKey, request.tenantId)) {
      return invalid(request.sourceAssertion, 'MAPPING_REJECTED');
    }
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
    const match = authorizationMatchesRequest(assessment, request);
    if (match === 'UNVERIFIABLE') {
      return unavailable(request.sourceAssertion, 'SOURCE_AUTHORITY');
    }
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
