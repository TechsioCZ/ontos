import type { PricingPurposeEquivalenceRequest } from '@app/catalog/api/pricing-purpose-equivalence';
import {
  PricingPurposeEquivalenceRequestSchema,
  PricingPurposeEquivalenceResponseSchema,
} from '@app/catalog/api/pricing-purpose-equivalence';
import { executePricingPurposeEquivalenceWithAuthorization } from '@app/catalog/api/pricing-purpose-equivalence-client';
import type { QuantityBasisCompatibilityRequest } from '@app/catalog/api/quantity-basis-compatibility';
import {
  QuantityBasisCompatibilityRequestSchema,
  QuantityBasisCompatibilityResponseSchema,
} from '@app/catalog/api/quantity-basis-compatibility';
import { executeQuantityBasisCompatibilityWithAuthorization } from '@app/catalog/api/quantity-basis-compatibility-client';
import type { CustomerPriceGroupResolutionRequest } from '@app/commerce-customer-context/api/customer-price-group-resolution';
import {
  CustomerPriceGroupResolutionRequestSchema,
  CustomerPriceGroupResolutionResponseSchema,
} from '@app/commerce-customer-context/api/customer-price-group-resolution';
import { executeCustomerPriceGroupResolutionWithAuthorization } from '@app/commerce-customer-context/api/customer-price-group-resolution/client';
import type {
  PricingCurrentMarketEvidenceRequest,
  PricingCurrentMarketEvidenceResponse,
} from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import {
  PricingCurrentMarketEvidenceRequestSchema,
  PricingCurrentMarketEvidenceResponseSchema,
  PricingMarketSourceReceiptSchema as OwnerPricingMarketSourceReceiptSchema,
} from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import { executePricingCurrentMarketEvidenceWithAuthorization } from '@app/commerce-market-catalog/api/pricing-current-market-evidence-client';
import type { ActiveApplicationCompositionServiceContract } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import {
  PricingMaterialEvidenceFenceSourceSchema,
  PricingSetBackedMaterialEvidenceFenceSourceSchema,
} from '@app/pricing-contracts/domain/material-evidence';
import {
  PriceGroupAssignmentResolutionResponseSchema,
  PriceGroupInterpretationInputSchema,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import {
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { DateTime, Effect, Match, Option, Redacted, Schema } from 'effect';

import type { CatalogSelectionGatewayCredentialIssuer } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import {
  CatalogSelectionGatewayCredentialService,
  unavailableCatalogSelectionGatewayCredentialIssuer,
} from '../../shared/domain/catalog-selection-gateway-credential.ts';
import type { CommercePriceGroupResolutionGatewayCredentialIssuer } from '../../shared/domain/commerce-price-group-resolution-gateway-credential.ts';
import {
  CommercePriceGroupResolutionGatewayCredentialService,
  unavailableCommercePriceGroupResolutionGatewayCredentialIssuer,
} from '../../shared/domain/commerce-price-group-resolution-gateway-credential.ts';
import type { CommercialContextGatewayCredentialIssuer } from '../../shared/domain/commercial-context-gateway-credential.ts';
import {
  CommercialContextGatewayCredentialService,
  unavailableCommercialContextGatewayCredentialIssuer,
} from '../../shared/domain/commercial-context-gateway-credential.ts';
import type { PricingExternalOwnerEvidenceValidationService } from '../services/external-owner-evidence-validation.service.ts';
import { PricingExternalOwnerEvidenceValidation } from '../services/external-owner-evidence-validation.service.ts';
import type { CurrentPricingDecisionOwnerReadFailure as CurrentPricingDecisionOwnerReadFailureType } from '../services/current-pricing-decision-whole-evaluation.service.ts';
import { CurrentPricingDecisionOwnerReadFailure } from '../services/current-pricing-decision-whole-evaluation.service.ts';
import { makeCurrentPricingDecisionExternalOwnerEvidencePort } from './current-pricing-decision-external-owner-evidence.ts';
import type {
  CurrentPricingDecisionCatalogEvidenceRead,
  CurrentPricingDecisionCustomerContextEvidenceRead,
  CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  CurrentPricingDecisionMarketEvidenceRead,
  CurrentPricingDecisionPromotionEvidenceRead,
} from './current-pricing-decision-external-owner-evidence.ts';
import { makePromotionModuleNotInstalledFinalFenceGateway } from './promotion-module-not-installed-final-fence.ts';

const CATALOG_OWNER = 'commerce.catalog';
const CUSTOMER_CONTEXT_OWNER = 'commerce.customer-context';
const MARKET_OWNER = 'commerce.market-catalog';
const PROMOTION_OWNER = 'commerce.promotion';

export interface CurrentPricingDecisionExternalOwnerEvidenceEnvironment {
  readonly legalEntityId: string;
  readonly requestCorrelation: string;
  readonly tenantId: string;
}

type CatalogClientEffect = ReturnType<typeof executePricingPurposeEquivalenceWithAuthorization>;
type CatalogClientFailure =
  CatalogClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type CatalogExecutor = (
  payload: PricingPurposeEquivalenceRequest,
  credential: Redacted.Redacted,
  correlation: string,
  options: { readonly baseUrl: URL },
) => Effect.Effect<unknown, CatalogClientFailure>;

type CatalogCompatibilityClientEffect = ReturnType<typeof executeQuantityBasisCompatibilityWithAuthorization>;
type CatalogCompatibilityClientFailure =
  CatalogCompatibilityClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type CatalogCompatibilityExecutor = (
  payload: QuantityBasisCompatibilityRequest,
  credential: Redacted.Redacted,
  correlation: string,
  options: { readonly baseUrl: URL },
) => Effect.Effect<unknown, CatalogCompatibilityClientFailure>;

type MarketClientEffect = ReturnType<typeof executePricingCurrentMarketEvidenceWithAuthorization>;
type MarketClientFailure = MarketClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type MarketExecutor = (
  payload: PricingCurrentMarketEvidenceRequest,
  credential: Redacted.Redacted,
  correlation: string,
  options: { readonly baseUrl: URL },
) => Effect.Effect<unknown, MarketClientFailure>;

type CustomerClientEffect = ReturnType<typeof executeCustomerPriceGroupResolutionWithAuthorization>;
type CustomerClientFailure =
  CustomerClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type CustomerExecutor = (
  payload: CustomerPriceGroupResolutionRequest,
  credential: Redacted.Redacted,
  correlation: string,
  options: { readonly baseUrl: URL },
) => Effect.Effect<unknown, CustomerClientFailure>;

interface LiveDependencies {
  readonly applicationComposition?: ActiveApplicationCompositionServiceContract;
  readonly catalog: {
    readonly execute: CatalogExecutor;
    readonly executeCompatibility: CatalogCompatibilityExecutor;
    readonly issuer: CatalogSelectionGatewayCredentialIssuer;
  };
  readonly customerContext: {
    readonly execute: CustomerExecutor;
    readonly issuer: CommercePriceGroupResolutionGatewayCredentialIssuer;
  };
  readonly market: { readonly execute: MarketExecutor; readonly issuer: CommercialContextGatewayCredentialIssuer };
  readonly validation: PricingExternalOwnerEvidenceValidationService;
}

const executeCatalog: CatalogExecutor = (payload, credential, correlation, options) =>
  executePricingPurposeEquivalenceWithAuthorization(payload, Redacted.value(credential), correlation, options);
const executeCatalogCompatibility: CatalogCompatibilityExecutor = (payload, credential, correlation, options) =>
  executeQuantityBasisCompatibilityWithAuthorization(payload, Redacted.value(credential), correlation, options);
const executeMarket: MarketExecutor = (payload, credential, correlation, options) =>
  executePricingCurrentMarketEvidenceWithAuthorization(payload, Redacted.value(credential), correlation, options);
const executeCustomer: CustomerExecutor = (payload, credential, correlation, options) =>
  executeCustomerPriceGroupResolutionWithAuthorization(payload, Redacted.value(credential), correlation, options);

const failed = (
  kind: CurrentPricingDecisionOwnerReadFailureType['kind'],
  ownerRef: string,
  reason: string,
  cause?: unknown,
): CurrentPricingDecisionOwnerReadFailureType => {
  const result = new CurrentPricingDecisionOwnerReadFailure({ kind, ownerRefs: [ownerRef], reason });
  return cause === undefined ? result : Object.defineProperty(result, 'cause', { configurable: true, value: cause });
};

const verifiedSourceEvidenceSchema = Schema.Union([
  PricingSourceEvidenceVerifiedPresentSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
]);
const customerGroupReceiptProjectionSchema = Schema.Struct({
  completenessEvidence: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  observedAt: PricingInstantSchema,
  verificationReceipt: Schema.Struct({
    predicateRef: Schema.String,
    verificationRef: Schema.String,
  }),
});
type PriceGroupPublicationResponse = typeof PriceGroupAssignmentResolutionResponseSchema.Type;
type VerifiedSourceEvidence = typeof verifiedSourceEvidenceSchema.Type;
type SourceCompletenessEvidence = VerifiedSourceEvidence['completeness']['completenessEvidence'];
type SourceInstant = VerifiedSourceEvidence['request']['effectiveAt'];

const instant = (value: DateTime.Utc): string => DateTime.formatIso(value);

interface SourceInput {
  readonly completeness: SourceCompletenessEvidence;
  readonly currentFacts?: readonly {
    readonly effectiveFrom: SourceInstant;
    readonly effectiveTo: null | SourceInstant;
    readonly factRef: string;
    readonly factRevisionRef: string;
    readonly verificationRef: string;
  }[];
  readonly effectiveAt: SourceInstant;
  readonly family: 'COMMERCIAL_CONTEXT';
  readonly ownerModuleId: string;
  readonly ownerRootRef: string;
  readonly predicateRef: string;
  readonly requestedAt: SourceInstant;
  readonly tenantId: string;
  readonly verificationRef: string;
}

const sourceEvidence = (input: SourceInput) => {
  const ownerScope = {
    ownerModuleId: input.ownerModuleId,
    ownerRootRef: input.ownerRootRef,
    predicateRef: input.predicateRef,
    tenantId: input.tenantId,
  };
  const temporalBase = {
    effectiveAt: input.effectiveAt,
    evaluatedAt: input.effectiveAt,
    evaluationMode: 'HISTORICAL_AS_OF' as const,
    observedAt: input.completeness.observedAt,
    requestedAt: input.requestedAt,
  };
  const temporal =
    input.completeness.nextApplicabilityBoundary === undefined
      ? temporalBase
      : { ...temporalBase, nextMaterialBoundary: input.completeness.nextApplicabilityBoundary };
  const request = { effectiveAt: input.effectiveAt, family: input.family, ownerScope, requestedAt: input.requestedAt };
  const completeness = {
    completenessEvidence: input.completeness,
    family: input.family,
    ownerScope,
    ownerSetRevisionRef: input.completeness.ownerRevision,
    temporal,
    verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const, verificationRef: input.verificationRef },
  };
  const candidate =
    input.currentFacts === undefined || input.currentFacts.length === 0
      ? { _tag: 'VERIFIED_ABSENT' as const, completeness, request }
      : {
          _tag: 'VERIFIED_PRESENT' as const,
          completeness,
          currentFacts: input.currentFacts.map((fact) => ({
            effectivePeriod: { effectiveFrom: fact.effectiveFrom, effectiveTo: fact.effectiveTo },
            factRef: fact.factRef,
            factRevisionRef: fact.factRevisionRef,
            family: input.family,
            ownerScope,
            temporal,
            verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const, verificationRef: fact.verificationRef },
          })),
          request,
        };
  return Schema.decodeEffect(verifiedSourceEvidenceSchema, { onExcessProperty: 'error' })(candidate);
};

const mapFailure = (ownerRef: string, reason: string) => (cause: unknown) =>
  failed('UNAVAILABLE', ownerRef, reason, cause);

const acceptCustomerGroupResolution = () => Option.none<CurrentPricingDecisionOwnerReadFailureType>();
const rejectBrokenCustomerGroupResolution = () =>
  Option.some(failed('UNVERIFIABLE', CUSTOMER_CONTEXT_OWNER, 'Customer Price Group resolution is BROKEN'));
const rejectInconsistentCustomerGroupResolution = () =>
  Option.some(failed('CONFLICT', CUSTOMER_CONTEXT_OWNER, 'Customer Price Group resolution is INCONSISTENT'));

const makeCatalogReader = (
  environment: CurrentPricingDecisionExternalOwnerEvidenceEnvironment,
  dependencies: LiveDependencies['catalog'],
) => ({
  loadFresh: Effect.fn('CurrentPricingDecisionCatalogEvidence.loadFresh')(function* loadFresh(
    context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  ) {
    const [firstLine] = context.request.decision.lines;
    if (firstLine === undefined) {
      return yield* failed('UNVERIFIABLE', CATALOG_OWNER, 'Catalog evidence requires at least one Pricing line');
    }
    const request = yield* Schema.decodeEffect(PricingPurposeEquivalenceRequestSchema)({
      anchorSelection: firstLine.catalog.selection,
      effectiveAt: context.effectiveAt,
      members: context.request.decision.lines.map((line) => ({
        handoff: line.catalog,
        occurrenceId: line.occurrenceId,
      })),
    }).pipe(Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog equivalence request is invalid')));
    const { baseUrl, credential } = yield* dependencies.issuer
      .issue({
        audience: 'catalog',
        legalEntityId: environment.legalEntityId,
        requestCorrelation: environment.requestCorrelation,
      })
      .pipe(Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog owner credential is unavailable')));
    const raw = yield* dependencies
      .execute(request, credential, environment.requestCorrelation, { baseUrl })
      .pipe(Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog equivalence read is unavailable')));
    const response = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceResponseSchema)(raw).pipe(
      Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog equivalence response is unverifiable')),
    );
    if (response.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED') {
      return yield* failed(
        response.outcome === 'CATALOG_EQUIVALENCE_CONFLICT' ? 'CONFLICT' : 'UNVERIFIABLE',
        CATALOG_OWNER,
        `Catalog equivalence refused the exact Pricing candidate with ${response.outcome}`,
      );
    }
    const memberAssessments = response.assessments.slice(1);
    if (
      memberAssessments.length !== request.members.length ||
      memberAssessments.some(
        (assessment, index) =>
          assessment.role !== 'MEMBER' || assessment.occurrenceId !== request.members[index]?.occurrenceId,
      )
    ) {
      return yield* failed('UNVERIFIABLE', CATALOG_OWNER, 'Catalog equivalence did not preserve ordered members');
    }
    const mapCatalogMember = Effect.fn('CurrentPricingDecisionCatalogEvidence.mapMember')(function* mapCatalogMember(
      member: (typeof request.members)[number],
      index: number,
    ) {
      const assessment = memberAssessments[index];
      if (assessment === undefined || assessment.role !== 'MEMBER') {
        return yield* failed('UNVERIFIABLE', CATALOG_OWNER, 'Catalog equivalence member is missing');
      }
      const { handoff } = assessment;
      const basisFacts = handoff.evidence.basis.map(({ source }) => ({
        effectiveFrom: handoff.evidence.assessedAt,
        effectiveTo: handoff.evidence.validUntil ?? null,
        factRef: source.resourceRef.resourceId,
        factRevisionRef: source.revisionId ?? String(source.revision),
        verificationRef: handoff.evidence.membership.attestationId,
      }));
      const evidence = yield* sourceEvidence({
        completeness: handoff.completeness,
        currentFacts: basisFacts,
        effectiveAt: context.effectiveAt,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: CATALOG_OWNER,
        ownerRootRef: handoff.equivalentSelectionKey,
        predicateRef: handoff.completeness.scope.predicateRef,
        requestedAt: context.requestedAt,
        tenantId: environment.tenantId,
        verificationRef: handoff.evidence.membership.attestationId,
      }).pipe(Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog line source proof is unverifiable')));
      const line = context.request.decision.lines[index];
      const rawLine = context.commercialTotal.sourceEvidence.preRound.rawComposition.lines[index];
      if (line === undefined) {
        return yield* failed('UNVERIFIABLE', CATALOG_OWNER, 'Catalog line disappeared during evidence mapping');
      }
      if (rawLine === undefined || !('usedPrice' in rawLine.unitPriceCalculation.input.exactPrice.path)) {
        return yield* failed(
          'UNVERIFIABLE',
          CATALOG_OWNER,
          'Catalog compatibility replay requires the exact successful Price path',
        );
      }
      const targetRef = handoff.selection.packageOption?.optionRef ?? handoff.selection.variantRef;
      const compatibilityRequest = yield* Schema.decodeEffect(QuantityBasisCompatibilityRequestSchema)({
        effectiveAt: context.effectiveAt,
        handoff,
        price: {
          quantity: line.pricingBasis.quantity,
          quantityBasis: { ...handoff.quantityBasis, targetRef, unitRef: line.pricingBasis.unitRef },
        },
      }).pipe(Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog compatibility request is invalid')));
      const compatibilityRaw = yield* dependencies
        .executeCompatibility(compatibilityRequest, credential, environment.requestCorrelation, { baseUrl })
        .pipe(Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog compatibility replay is unavailable')));
      const compatibilityResponse = yield* Schema.decodeUnknownEffect(QuantityBasisCompatibilityResponseSchema)(
        compatibilityRaw,
      ).pipe(Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog compatibility replay is unverifiable')));
      if (
        compatibilityResponse.outcome !== 'NO_CONVERSION_REQUIRED' &&
        compatibilityResponse.outcome !== 'COMPATIBLE_CONVERSION'
      ) {
        return yield* failed(
          'UNVERIFIABLE',
          CATALOG_OWNER,
          `Catalog compatibility replay refused the exact line with ${compatibilityResponse.outcome}`,
        );
      }
      const fenceSource = yield* Schema.decodeEffect(PricingSetBackedMaterialEvidenceFenceSourceSchema)({
        sourceEvidence: evidence,
        verificationMaterial: {
          compatibilityRequest,
          compatibilityResponse,
          handoff,
          kind: 'CATALOG_LINE_AUTHORITY',
          line,
          request: { amount: handoff.quantity.requested, purpose: 'PRICING', selection: handoff.selection },
        },
      }).pipe(Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog line fence material is unverifiable')));
      return {
        fenceSource,
        occurrenceId: member.occurrenceId,
        publication: {
          assessment: handoff.evidence,
          expectedEffectiveAt: context.effectiveAt,
          expectedOwnerRootRef: handoff.equivalentSelectionKey,
          expectedPredicateRef: handoff.completeness.scope.predicateRef,
          expectedSelection: handoff.selection,
          requestedAt: context.requestedAt,
          sourceEvidence: evidence,
        },
      };
    });
    const members = yield* Effect.forEach(request.members, mapCatalogMember, { concurrency: 8 });
    const receipt = response.verificationReceipt;
    const equivalencePredicateRef = receipt.predicateRef;
    const equivalenceEvidence = yield* sourceEvidence({
      completeness: {
        nextApplicabilityBoundary: response.currentnessEvidence.validThrough,
        observedAt: response.currentnessEvidence.observedAt,
        ownerRevision: receipt.ownerRevision,
        scope: { kind: 'EXACT_PREDICATE', predicateRef: equivalencePredicateRef },
      },
      currentFacts: [
        {
          effectiveFrom: response.evidence.effectiveAt,
          effectiveTo: response.evidence.validThrough,
          factRef: response.evidence.assessmentId,
          factRevisionRef: response.generation,
          verificationRef: receipt.verificationRef,
        },
      ],
      effectiveAt: context.effectiveAt,
      family: 'COMMERCIAL_CONTEXT',
      ownerModuleId: CATALOG_OWNER,
      ownerRootRef: response.evidence.assessmentId,
      predicateRef: equivalencePredicateRef,
      requestedAt: context.requestedAt,
      tenantId: environment.tenantId,
      verificationRef: receipt.verificationRef,
    }).pipe(Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog equivalence source proof is unverifiable')));
    const equivalenceFenceSource = yield* Schema.decodeEffect(PricingSetBackedMaterialEvidenceFenceSourceSchema)({
      sourceEvidence: equivalenceEvidence,
      verificationMaterial: { kind: 'CATALOG_EQUIVALENCE_AUTHORITY', request, response },
    }).pipe(Effect.mapError(mapFailure(CATALOG_OWNER, 'Catalog equivalence fence material is unverifiable')));
    return {
      equivalenceFenceSource,
      members,
    } satisfies CurrentPricingDecisionCatalogEvidenceRead;
  }),
});

const marketSourceEvidence = (
  context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  response: Extract<PricingCurrentMarketEvidenceResponse, { readonly outcome: 'PRICING_MARKET_SOURCE_PRESENT' }>,
) => {
  const { authority } = response.receipt;
  const completeness =
    authority.nextApplicabilityBoundary === undefined
      ? {
          observedAt: instant(authority.observedAt),
          ownerRevision: authority.ownerSetRevisionRef,
          scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: authority.predicateRef },
        }
      : {
          nextApplicabilityBoundary: instant(authority.nextApplicabilityBoundary),
          observedAt: instant(authority.observedAt),
          ownerRevision: authority.ownerSetRevisionRef,
          scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: authority.predicateRef },
        };
  return sourceEvidence({
    completeness,
    currentFacts: response.receipt.currentFacts.map((fact) => ({
      effectiveFrom: instant(fact.effectivePeriod.startsAt),
      effectiveTo: fact.effectivePeriod.endsAt === undefined ? null : instant(fact.effectivePeriod.endsAt),
      factRef: fact.factRef,
      factRevisionRef: fact.factRevisionRef,
      verificationRef: fact.verificationRef,
    })),
    effectiveAt: context.effectiveAt,
    family: 'COMMERCIAL_CONTEXT',
    ownerModuleId: MARKET_OWNER,
    ownerRootRef: authority.ownerRootRef,
    predicateRef: authority.predicateRef,
    requestedAt: context.requestedAt,
    tenantId: context.request.decision.tenantId,
    verificationRef: authority.verificationRef,
  });
};

const makeMarketReader = (
  environment: CurrentPricingDecisionExternalOwnerEvidenceEnvironment,
  dependencies: LiveDependencies['market'],
) => ({
  loadFresh: Effect.fn('CurrentPricingDecisionMarketEvidence.loadFresh')(function* loadFresh(
    context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  ) {
    const { commercialScope, tenantId } = context.request.decision;
    const request = yield* Schema.decodeEffect(PricingCurrentMarketEvidenceRequestSchema)({
      commercialScope: {
        channel: commercialScope.channelId,
        marketRef: {
          moduleId: MARKET_OWNER,
          resourceId: commercialScope.marketId,
          resourceType: 'commerce.market-catalog.market',
          tenantId,
        },
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: commercialScope.sellingLegalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      },
      effectiveAt: context.effectiveAt,
      requestedAt: context.requestedAt,
    }).pipe(Effect.mapError(mapFailure(MARKET_OWNER, 'Market evidence request is invalid')));
    const { baseUrl, credential } = yield* dependencies.issuer
      .issue({
        audience: 'commerce-market-catalog',
        legalEntityId: environment.legalEntityId,
        requestCorrelation: environment.requestCorrelation,
      })
      .pipe(Effect.mapError(mapFailure(MARKET_OWNER, 'Market owner credential is unavailable')));
    const raw = yield* dependencies
      .execute(request, credential, environment.requestCorrelation, { baseUrl })
      .pipe(Effect.mapError(mapFailure(MARKET_OWNER, 'Market owner evidence is unavailable')));
    const response = yield* Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceResponseSchema)(raw).pipe(
      Effect.mapError(mapFailure(MARKET_OWNER, 'Market owner evidence response is unverifiable')),
    );
    if (response.outcome !== 'PRICING_MARKET_SOURCE_PRESENT') {
      return yield* failed(
        response.outcome === 'PRICING_MARKET_SOURCE_CONFLICT' ? 'CONFLICT' : 'UNVERIFIABLE',
        MARKET_OWNER,
        `Market owner did not prove the selected commercial context: ${response.outcome}`,
      );
    }
    const evidence = yield* marketSourceEvidence(context, response).pipe(
      Effect.mapError(mapFailure(MARKET_OWNER, 'Market source proof is unverifiable')),
    );
    const encodedReceipt = yield* Schema.encodeUnknownEffect(OwnerPricingMarketSourceReceiptSchema)(
      response.receipt,
    ).pipe(Effect.mapError(mapFailure(MARKET_OWNER, 'Market receipt cannot be retained losslessly')));
    const fenceSource = yield* Schema.decodeEffect(PricingSetBackedMaterialEvidenceFenceSourceSchema)({
      sourceEvidence: evidence,
      verificationMaterial: { commercialScope, kind: 'MARKET_CONTEXT_AUTHORITY', receipt: encodedReceipt },
    }).pipe(Effect.mapError(mapFailure(MARKET_OWNER, 'Market fence material is unverifiable')));
    return {
      fenceSource,
      publication: {
        expectedCommercialScope: commercialScope,
        expectedEffectiveAt: context.effectiveAt,
        expectedOwnerRootRef: response.receipt.authority.ownerRootRef,
        expectedPredicateRef: response.receipt.authority.predicateRef,
        requestedAt: context.requestedAt,
        response,
        sourceEvidence: evidence,
        tenantId,
      },
    } satisfies CurrentPricingDecisionMarketEvidenceRead;
  }),
});

const profileGroupInput = (context: CurrentPricingDecisionExternalOwnerEvidenceReadContext) => {
  if (context.request.subject.kind !== 'PROFILE') {
    return Option.none();
  }
  const resolutionInput =
    context.commercialTotal.sourceEvidence.preRound.rawComposition.lines[0]?.unitPriceCalculation.input.exactPrice.path
      .resolutionInput;
  if (resolutionInput === undefined) {
    return Option.none();
  }
  const interpretableResolutionInput = Match.value(resolutionInput).pipe(
    Match.tags({
      ASSIGNED: (assigned) => Option.some(assigned),
      BLOCKED: () => Option.none(),
      GUEST: () => Option.none(),
      OWNER_NONE: (ownerNone) => Option.some(ownerNone),
    }),
    Match.exhaustive,
  );
  if (Option.isNone(interpretableResolutionInput)) {
    return Option.none();
  }
  const interpretedInput = interpretableResolutionInput.value;
  const decodedInput = Schema.decodeUnknownOption(PriceGroupInterpretationInputSchema)({
    assignmentRequest: {
      authorizationSubject: context.request.subject.authorizationSubject,
      effectiveAt: context.effectiveAt,
      profile: { ...context.request.subject.profileRef, kind: context.request.subject.authorizationSubject.kind },
    },
    basis: interpretedInput.interpretation.basis,
  });
  if (Option.isNone(decodedInput) || 'kind' in decodedInput.value.assignmentRequest) {
    return Option.none();
  }
  const request = {
    authorizationSubject: context.request.subject.authorizationSubject,
    effectiveAt: context.effectiveAt,
    profile: { ...context.request.subject.profileRef, kind: context.request.subject.authorizationSubject.kind },
  };
  return Option.some({
    input: decodedInput.value,
    interpretation: interpretedInput.interpretation,
    request,
  });
};

const groupSourceEvidence = (
  context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  response: PriceGroupPublicationResponse,
  receipt: typeof customerGroupReceiptProjectionSchema.Type,
) => {
  const assigned = Match.value(response.resolution).pipe(
    Match.tags({
      ASSIGNED: (resolution) => Option.some(resolution),
      BROKEN: () => Option.none(),
      INCONSISTENT: () => Option.none(),
      NONE: () => Option.none(),
    }),
    Match.exhaustive,
  );
  const base = {
    completeness: receipt.completenessEvidence,
    effectiveAt: context.effectiveAt,
    family: 'COMMERCIAL_CONTEXT',
    ownerModuleId: CUSTOMER_CONTEXT_OWNER,
    ownerRootRef: response.profile.resourceId,
    predicateRef: receipt.verificationReceipt.predicateRef,
    requestedAt: context.requestedAt,
    tenantId: context.request.decision.tenantId,
    verificationRef: receipt.verificationReceipt.verificationRef,
  } as const;
  return Option.isNone(assigned)
    ? sourceEvidence(base)
    : sourceEvidence({
        ...base,
        currentFacts: [
          {
            effectiveFrom: assigned.value.effectiveFrom,
            effectiveTo: assigned.value.effectiveTo,
            factRef: assigned.value.assignmentRef.resourceId,
            factRevisionRef: String(assigned.value.assignmentRevision),
            verificationRef: receipt.verificationReceipt.verificationRef,
          },
        ],
      });
};

const makeCustomerContextReader = (
  environment: CurrentPricingDecisionExternalOwnerEvidenceEnvironment,
  dependencies: LiveDependencies['customerContext'],
) => ({
  loadFresh: Effect.fn('CurrentPricingDecisionCustomerContextEvidence.loadFresh')(function* loadFresh(
    context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  ) {
    const { commercialScope, purchasingContext, tenantId } = context.request.decision;
    const { subjectAuthority } = context.purchaseContextEvidence;
    if (subjectAuthority.kind !== context.request.subject.kind) {
      return yield* failed(
        'UNVERIFIABLE',
        CUSTOMER_CONTEXT_OWNER,
        'Purchase Context subject authority does not match the exact Pricing subject',
      );
    }
    const purchaseRequest = {
      actor:
        subjectAuthority.kind === 'PROFILE'
          ? { kind: 'AUTHENTICATED_CUSTOMER', principalId: subjectAuthority.actorPrincipalId }
          : { kind: 'GUEST' },
      operationTime: context.effectiveAt,
      purchasingContext: {
        ...purchasingContext,
        channelId: commercialScope.channelId,
        marketId: commercialScope.marketId,
        sellingLegalEntityId: commercialScope.sellingLegalEntityId,
      },
      subject: context.request.subject,
      tenantId,
    };
    const purchaseFenceSource = yield* Schema.decodeUnknownEffect(PricingMaterialEvidenceFenceSourceSchema)({
      verificationMaterial: {
        evidence: context.purchaseContextEvidence,
        kind: 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY',
        request: purchaseRequest,
      },
    }).pipe(Effect.mapError(mapFailure(CUSTOMER_CONTEXT_OWNER, 'Purchase Context fence material is unverifiable')));
    if (context.request.subject.kind === 'GUEST') {
      return {
        fenceSources: [purchaseFenceSource],
        subjectEvidence: context.purchaseContextEvidence,
      } satisfies CurrentPricingDecisionCustomerContextEvidenceRead;
    }
    const groupOption = profileGroupInput(context);
    if (Option.isNone(groupOption)) {
      return yield* failed(
        'UNVERIFIABLE',
        CUSTOMER_CONTEXT_OWNER,
        'A successful external evidence snapshot requires one exact Profile Price Group interpretation',
      );
    }
    const group = groupOption.value;
    const request = yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionRequestSchema)(group.request).pipe(
      Effect.mapError(mapFailure(CUSTOMER_CONTEXT_OWNER, 'Customer Price Group request is invalid')),
    );
    const { baseUrl, credential } = yield* dependencies.issuer
      .issue({
        audience: 'commerce-customer-context',
        legalEntityId: environment.legalEntityId,
        requestCorrelation: environment.requestCorrelation,
      })
      .pipe(Effect.mapError(mapFailure(CUSTOMER_CONTEXT_OWNER, 'Customer Context credential is unavailable')));
    const raw = yield* dependencies
      .execute(request, credential, environment.requestCorrelation, { baseUrl })
      .pipe(Effect.mapError(mapFailure(CUSTOMER_CONTEXT_OWNER, 'Customer Price Group owner read is unavailable')));
    yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionResponseSchema)(raw).pipe(
      Effect.mapError(mapFailure(CUSTOMER_CONTEXT_OWNER, 'Customer Price Group response is unverifiable')),
    );
    const receipt = yield* Schema.decodeUnknownEffect(customerGroupReceiptProjectionSchema)(raw).pipe(
      Effect.mapError(mapFailure(CUSTOMER_CONTEXT_OWNER, 'Customer Price Group receipt is unverifiable')),
    );
    const response = yield* Schema.decodeUnknownEffect(PriceGroupAssignmentResolutionResponseSchema)(raw).pipe(
      Effect.mapError(mapFailure(CUSTOMER_CONTEXT_OWNER, 'Customer Price Group resolution is unverifiable')),
    );
    const resolutionFailure = Match.value(response.resolution).pipe(
      Match.tag('ASSIGNED', acceptCustomerGroupResolution),
      Match.tag('BROKEN', rejectBrokenCustomerGroupResolution),
      Match.tag('INCONSISTENT', rejectInconsistentCustomerGroupResolution),
      Match.tag('NONE', acceptCustomerGroupResolution),
      Match.exhaustive,
    );
    if (Option.isSome(resolutionFailure)) {
      return yield* resolutionFailure.value;
    }
    const evidence = yield* groupSourceEvidence(context, response, receipt).pipe(
      Effect.mapError(mapFailure(CUSTOMER_CONTEXT_OWNER, 'Customer Price Group source proof is unverifiable')),
    );
    const fenceSource = yield* Schema.decodeUnknownEffect(PricingSetBackedMaterialEvidenceFenceSourceSchema)({
      sourceEvidence: evidence,
      verificationMaterial: {
        input: group.input,
        interpretation: group.interpretation,
        kind: 'CUSTOMER_CONTEXT_GROUP_AUTHORITY',
        request,
        response: raw,
      },
    }).pipe(Effect.mapError(mapFailure(CUSTOMER_CONTEXT_OWNER, 'Customer Price Group fence material is unverifiable')));
    return {
      fenceSources: [purchaseFenceSource, fenceSource],
      priceGroupPublication: {
        expectedEffectiveAt: context.effectiveAt,
        expectedOwnerRootRef: response.profile.resourceId,
        expectedPredicateRef: receipt.verificationReceipt.predicateRef,
        expectedProfile: response.profile,
        requestedAt: context.requestedAt,
        response,
        sourceEvidence: evidence,
      },
      // This evidence is the immediately preceding authenticated CCC owner read from the same
      // whole-evaluation attempt. The external port lacks trusted principal credentials to replay it.
      subjectEvidence: context.purchaseContextEvidence,
    } satisfies CurrentPricingDecisionCustomerContextEvidenceRead;
  }),
});

const makePromotionReader = (applicationComposition?: ActiveApplicationCompositionServiceContract) => ({
  loadFresh: Effect.fn('CurrentPricingDecisionPromotionEvidence.loadFresh')(function* loadFresh(
    context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  ) {
    const selected = context.commercialTotal.sourceEvidence.preRound.rawComposition.promotionComposition;
    if (selected.kind === 'PROMOTION_SELECTED') {
      return yield* failed(
        'UNAVAILABLE',
        PROMOTION_OWNER,
        'Selected Promotion evidence requires the owner replay endpoint tracked by #894',
      );
    }
    if (applicationComposition === undefined) {
      return yield* failed(
        'UNAVAILABLE',
        PROMOTION_OWNER,
        'Authoritative active Application Composition evidence for Promotion is unavailable',
      );
    }
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const gateway = makePromotionModuleNotInstalledFinalFenceGateway(applicationComposition.load);
    yield* gateway
      .verifyOpaqueProofsAgainstCurrentState({
        candidateRef: context.commercialTotal.candidateRef,
        sources: [],
        typedSources: [],
        verificationContext: {
          candidateRef: context.commercialTotal.candidateRef,
          decision: context.request.decision,
          effectiveAt: context.effectiveAt,
          evaluatedAt: checkedAt,
          requestedAt: context.requestedAt,
          subject: context.request.subject,
        },
      })
      .pipe(
        Effect.mapError(
          mapFailure(PROMOTION_OWNER, 'Active Application Composition cannot prove the source-free Promotion path'),
        ),
      );
    return { kind: 'PROMOTION_NOT_SELECTED' } satisfies CurrentPricingDecisionPromotionEvidenceRead;
  }),
});

export const makeCurrentPricingDecisionExternalOwnerEvidenceLivePort = (
  environment: CurrentPricingDecisionExternalOwnerEvidenceEnvironment,
  dependencies: LiveDependencies,
) =>
  makeCurrentPricingDecisionExternalOwnerEvidencePort({
    catalog: makeCatalogReader(environment, dependencies.catalog),
    customerContext: makeCustomerContextReader(environment, dependencies.customerContext),
    market: makeMarketReader(environment, dependencies.market),
    promotion: makePromotionReader(dependencies.applicationComposition),
    validation: dependencies.validation,
  });

export const currentPricingDecisionExternalOwnerEvidencePortFromEnvironment = (
  environment: CurrentPricingDecisionExternalOwnerEvidenceEnvironment,
) =>
  Effect.all(
    {
      applicationComposition: Effect.serviceOption(ActiveApplicationCompositionService),
      catalogIssuer: Effect.serviceOption(CatalogSelectionGatewayCredentialService),
      customerIssuer: Effect.serviceOption(CommercePriceGroupResolutionGatewayCredentialService),
      marketIssuer: Effect.serviceOption(CommercialContextGatewayCredentialService),
      validation: PricingExternalOwnerEvidenceValidation,
    },
    { concurrency: 5 },
  ).pipe(
    Effect.map(({ applicationComposition, catalogIssuer, customerIssuer, marketIssuer, validation }) => {
      const common = {
        catalog: {
          execute: executeCatalog,
          executeCompatibility: executeCatalogCompatibility,
          issuer: Option.isSome(catalogIssuer)
            ? catalogIssuer.value
            : unavailableCatalogSelectionGatewayCredentialIssuer,
        },
        customerContext: {
          execute: executeCustomer,
          issuer: Option.isSome(customerIssuer)
            ? customerIssuer.value
            : unavailableCommercePriceGroupResolutionGatewayCredentialIssuer,
        },
        market: {
          execute: executeMarket,
          issuer: Option.isSome(marketIssuer)
            ? marketIssuer.value
            : unavailableCommercialContextGatewayCredentialIssuer,
        },
        validation,
      } satisfies Omit<LiveDependencies, 'applicationComposition'>;
      return makeCurrentPricingDecisionExternalOwnerEvidenceLivePort(
        environment,
        Option.isSome(applicationComposition)
          ? { ...common, applicationComposition: applicationComposition.value }
          : common,
      );
    }),
  );
