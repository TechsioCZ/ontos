import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import type { CurrentSupportedCurrenciesSuccess } from '@app/pricing-contracts/current-supported-currencies';
import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts/current-supported-currencies';
import type { CurrentPricingDecisionRequest } from '@app/pricing-contracts/current-pricing-decision';
import { PricingDecisionSubjectSchema } from '@app/pricing-contracts/current-pricing-decision';
import type { PricingContractualDiscountCurrentSet } from '@app/pricing-contracts/domain/contractual-discount-set';
import type {
  ExactPriceLookupRequest,
  ExactPriceLookupResult,
  ExactPriceOwnerLookupResult,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import {
  ExactPriceConflictDiagnosticSchema,
  ExactPriceLookupAbsentSchema,
  ExactPriceLookupFoundSchema,
  ExactPriceLookupInvalidSchema,
  ExactPriceLookupResultSchema,
  ExactPriceLookupUnavailableSchema,
  ExactPriceLookupUnverifiableSchema,
  redactExactPriceConflictDiagnostic,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import type { ExactPriceResolution } from '@app/pricing-contracts/domain/exact-price-resolution';
import {
  ExactPriceAbsentResolutionSchema,
  ExactPriceFoundResolutionSchema,
} from '@app/pricing-contracts/domain/exact-price-resolution';
import { PricingLineCompositionRequestSchema } from '@app/pricing-contracts/domain/line-composition';
import { PRICING_ALLOCATION_CONTRACT_VERSION } from '@app/pricing-contracts/domain/discount-fee-allocation';
import { PRICING_ALLOCATION_PROFILE } from '@app/pricing-contracts/domain/exact-decimal';
import { PricingEvaluationAttemptSchema } from '@app/pricing-contracts/domain/material-change';
import type {
  PricingExactPriceOwnerReadReceipt,
  PricingMaterialEvidenceFenceSource,
  PricingMaterialDiscountSelection,
  PricingMaterialEvidenceAssemblyRequest,
  PricingOwnerFactProof,
} from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingDiscountSubjectEvidenceSchema,
  PricingMaterialDiscountSelectionSchema,
  PricingMaterialEvidenceAssemblyRequestSchema,
  PricingRetainedExternalOwnerEvidenceSchema,
} from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingDiscountIdentityBasisSchema,
  PricingDiscountIdentityKeySchema,
} from '@app/pricing-contracts/domain/discount';
import {
  PriceGroupAssignmentProfileSchema,
  PriceGroupInterpretationInputSchema,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import type { QuantityTierSelectionAttempt } from '@app/pricing-contracts/domain/quantity-tier';
import type { QuantityTierAggregationAttempt } from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import type { PricingMaterialCurrentBinding, PricingNoApplicablePrice } from '@app/pricing-contracts/pricing-decision';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import type {
  PricingSourceEvidenceFamily,
  PricingSourceEvidenceResult,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import {
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { DateTime, Effect, Layer, Match, Option, Schema } from 'effect';

import { resolveCurrentSupportedCurrencies } from '../api/current-supported-currencies.read.ts';
import { currencySupportPersistenceForScope } from '../persistence/currency-support-persistence.ts';
import type { CommercialFeePersistence } from '../services/commercial-fee-persistence.service.ts';
import { commercialFeePersistenceForScope } from '../services/commercial-fee-persistence.service.ts';
import type { ContractualDiscountPersistence } from '../services/contractual-discount-persistence.service.ts';
import { contractualDiscountPersistenceForScope } from '../services/contractual-discount-persistence.service.ts';
import type {
  CurrentPricingDecisionAttemptSourcePort,
  CurrentPricingDecisionDiscountSetReaderPort,
  CurrentPricingDecisionFeeSetReaderPort,
  CurrentPricingDecisionTierSetReaderPort,
  CurrentPricingDecisionWholeCompositionPort,
  CurrentPricingDecisionZeroFloorSetReaderPort,
} from '../services/current-pricing-decision-whole-evaluation.service.ts';
import {
  CurrentPricingDecisionAttemptSource,
  CurrentPricingDecisionDiscountSetReader,
  CurrentPricingDecisionExternalOwnerEvidence,
  CurrentPricingDecisionFeeSetReader,
  CurrentPricingDecisionOwnerReadFailure,
  CurrentPricingDecisionTierSetReader,
  CurrentPricingDecisionWholeComposition,
  CurrentPricingDecisionZeroFloorSetReader,
  makeCurrentPricingDecisionWholeEvaluationService,
} from '../services/current-pricing-decision-whole-evaluation.service.ts';
import type { ExactPriceResolutionService as ExactPriceResolutionPort } from '../services/exact-price-resolution.service.ts';
import { ExactPriceResolver, exactPriceResolutionServiceForScope } from '../services/exact-price-resolution.service.ts';
import type { PricingDiscountApplicability } from '../services/discount-applicability.service.ts';
import { resolveCurrentPricingDiscountRevisions } from '../services/discount-applicability.service.ts';
import {
  makePricingPromotionCompositionService,
  unavailablePromotionContributionSource,
} from '../services/promotion-contribution-composition.service.ts';
import {
  PricingPromotionCurrentEvaluation,
  makePricingPromotionCurrentEvaluationService,
} from '../services/promotion-current-evaluation.service.ts';
import { PricingPromotionUnavailable } from '../services/pricing-promotion-unavailable.ts';
import type { PriceGroupInterpretationService as PriceGroupInterpretationPort } from '../services/price-group-interpretation.service.ts';
import { makePriceGroupInterpretationService } from '../services/price-group-interpretation.service.ts';
import type { ExactPriceCandidateSetPersistence, PricePersistence } from '../services/price-persistence.service.ts';
import { pricePersistenceForScope } from '../services/price-persistence.service.ts';
import type { QuantityTierPersistence } from '../services/quantity-tier-persistence.service.ts';
import { quantityTierPersistenceForScope } from '../services/quantity-tier-persistence.service.ts';
import { aggregateQuantityTierLines } from '../services/quantity-tier-aggregation.service.ts';
import { assessPricingQuantityBasis } from '../services/quantity-unit-package-basis.service.ts';
import type { ZeroFloorAuthorizationPersistence } from '../services/zero-floor-authorization-persistence.service.ts';
import { zeroFloorAuthorizationPersistenceForScope } from '../services/zero-floor-authorization-persistence.service.ts';
import type { CurrentPricingDecisionSubjectAuthorityEvidence } from '../services/current-pricing-decision-subject-authority.service.ts';
import type { CatalogQuantityBasisCompatibilityPort } from './catalog-quantity-basis-compatibility.ts';
import { catalogQuantityBasisCompatibilityPortFromEnvironment } from './catalog-quantity-basis-compatibility.ts';
import type { CatalogPricingPurposeEquivalencePort } from './catalog-pricing-purpose-equivalence.ts';
import { catalogPricingPurposeEquivalencePortFromEnvironment } from './catalog-pricing-purpose-equivalence.ts';
import { commercePriceGroupResolutionPortFromEnvironment } from './commerce-price-group-resolution.ts';
import { currentPricingDecisionExternalOwnerEvidencePortFromEnvironment } from './current-pricing-decision-external-owner-evidence-live.ts';
import { priceGroupCompatibilityPortFromEnvironment } from './price-group-compatibility.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const EXACT_PRICE_OWNER_REF = 'pricing-price:exact-current-set';
const CURRENCY_SUPPORT_OWNER_REF = 'pricing-currency-support:current-set';
const QUANTITY_TIER_OWNER_REF = 'pricing-quantity-tier:current-set';
const DISCOUNT_OWNER_REF = 'pricing-contractual-discount:current-set';
const DISCOUNT_AUDIENCE_OWNER_REF = 'commerce-customer-context:discount-audience';
const MATERIAL_EVIDENCE_OWNER_REF = 'pricing-current-decision:material-evidence';
const NO_PRICE_OWNER_REF = 'pricing-current-decision:no-price';

const failure = (
  kind: CurrentPricingDecisionOwnerReadFailure['kind'],
  ownerRef: string,
  reason: string,
  cause?: unknown,
): CurrentPricingDecisionOwnerReadFailure => {
  const result = new CurrentPricingDecisionOwnerReadFailure({ kind, ownerRefs: [ownerRef], reason });
  return cause === undefined ? result : Object.defineProperty(result, 'cause', { configurable: true, value: cause });
};
const unavailable = (ownerRef: string, reason: string) => (cause: unknown) =>
  failure('UNAVAILABLE', ownerRef, reason, cause);

const identityBasis = (
  request: CurrentPricingDecisionRequest,
  line: CurrentPricingDecisionRequest['decision']['lines'][number],
) => ({
  catalogSelection: line.catalog.selection,
  commercialScope: request.decision.commercialScope,
  currencyCode: request.decision.currencyCode,
  unitBasis: line.pricingBasis,
});

const fallbackInput = Effect.fn('CurrentPricingDecisionAdapters.fallbackInput')(function* fallbackInputProgram(
  request: CurrentPricingDecisionRequest,
  line: CurrentPricingDecisionRequest['decision']['lines'][number],
  interpreter: PriceGroupInterpretationPort,
) {
  const basis = identityBasis(request, line);
  if (request.subject.kind === 'GUEST') {
    return { _tag: 'GUEST' as const, basis, effectiveAt: request.decision.operationTime };
  }
  const profile = yield* Schema.decodeUnknownEffect(PriceGroupAssignmentProfileSchema)({
    ...request.subject.profileRef,
    kind: request.subject.authorizationSubject.kind,
  }).pipe(
    Effect.mapError((cause) =>
      failure(
        'UNVERIFIABLE',
        'commerce-customer-context:profile',
        'Profile is not a verifiable assignment subject',
        cause,
      ),
    ),
  );
  const interpretation = yield* interpreter.interpret({
    assignmentRequest: {
      authorizationSubject: request.subject.authorizationSubject,
      effectiveAt: request.decision.operationTime,
      profile,
    },
    basis,
  });
  return Match.value(interpretation).pipe(
    Match.tag('ASSIGNED', (value) => ({
      _tag: 'ASSIGNED' as const,
      effectiveAt: request.decision.operationTime,
      interpretation: value,
    })),
    Match.tag('NONE', (value) => ({
      _tag: 'OWNER_NONE' as const,
      effectiveAt: request.decision.operationTime,
      interpretation: value,
      ownerResolution: {
        effectiveAt: request.decision.operationTime,
        profile,
        resolution: value.assignmentResolution,
      },
    })),
    Match.orElse((value) => ({
      _tag: 'BLOCKED' as const,
      effectiveAt: request.decision.operationTime,
      interpretation: value,
    })),
  );
});

const supportEvidence = (
  support: CurrentSupportedCurrenciesSuccess,
  currencyCode: string,
): Option.Option<PricingSourceEvidenceResult> => {
  const [factProof] = support.factProofs;
  if (factProof === undefined) {
    return Option.none();
  }
  const requestedAt = support.effectiveAt;
  const ownerScope = {
    ownerModuleId: 'commerce.pricing',
    ownerRootRef: support.supportRootRef.resourceId,
    predicateRef: support.completenessEvidence.scope.predicateRef,
    tenantId: support.tenantId,
  };
  const temporal = {
    effectiveAt: support.effectiveAt,
    evaluatedAt: support.currentnessEvidence.evaluatedAt,
    evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
    observedAt: support.observedAt,
    requestedAt,
  };
  if (support.nextApplicabilityBoundary !== undefined) {
    Object.assign(temporal, { nextMaterialBoundary: support.nextApplicabilityBoundary });
  }
  const verification = {
    kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
    verificationRef: support.verificationRef,
  };
  return Option.some({
    _tag: 'VERIFIED_PRESENT',
    completeness: {
      completenessEvidence: support.completenessEvidence,
      currencyCode,
      family: 'CURRENCY_SUPPORT',
      ownerScope,
      ownerSetRevisionRef: support.supportRevisionRef.resourceId,
      temporal,
      verification,
    },
    currentFacts: [
      {
        currencyCode,
        effectivePeriod: support.effectivePeriod,
        factRef: factProof.factRef,
        factRevisionRef: factProof.factRevisionRef,
        family: 'CURRENCY_SUPPORT',
        ownerScope,
        temporal,
        verification: {
          kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
          verificationRef: factProof.verificationRef,
        },
      },
    ],
    request: { currencyCode, effectiveAt: support.effectiveAt, family: 'CURRENCY_SUPPORT', ownerScope, requestedAt },
  });
};

export interface CurrentPricingDecisionAttemptSourcePorts {
  readonly catalogQuantity: CatalogQuantityBasisCompatibilityPort;
  readonly exactPrice: ExactPriceResolutionPort;
  readonly interpreter: PriceGroupInterpretationPort;
  readonly loadCurrencySupport: Parameters<typeof resolveCurrentSupportedCurrencies>[2];
  readonly priceCandidateSets: Pick<ExactPriceCandidateSetPersistence, 'readExactCandidateSet'>;
}

const ownerLookupFromCandidateSet = (
  request: ExactPriceLookupRequest,
  outcome: Effect.Success<ReturnType<ExactPriceCandidateSetPersistence['readExactCandidateSet']>>,
): ExactPriceOwnerLookupResult => {
  if (outcome.outcome === 'EXACT_PRICE_CANDIDATE_SET_UNVERIFIABLE') {
    return { _tag: 'UNVERIFIABLE', reason: 'SET_COMPLETENESS_UNVERIFIABLE', request };
  }
  const evidence = {
    effectiveAt: request.effectiveAt,
    observedAt: outcome.authority.observedAt,
    ownerRevision: outcome.authority.ownerRevision,
  };
  if (outcome.authority.nextApplicabilityBoundary !== undefined) {
    Object.assign(evidence, { nextApplicabilityBoundary: outcome.authority.nextApplicabilityBoundary });
  }
  if (outcome.outcome === 'EXACT_PRICE_CANDIDATE_SET_CONFLICT') {
    return {
      _tag: 'EXACT_PRICE_CONFLICT_DIAGNOSTIC',
      claimants: outcome.candidateSet.candidates,
      evidence,
      reason: 'COMPETING_CURRENT_EXACT_PRICES',
      request,
      verification: 'OWNER_VERIFIED_COMPLETE_CURRENT_SET',
    };
  }
  const [candidate] = outcome.candidateSet.candidates;
  return candidate === undefined
    ? { _tag: 'ABSENT', evidence, request }
    : {
        _tag: 'FOUND',
        evidence,
        priceRef: candidate.priceRef,
        priceRevision: candidate.priceRevision,
        request,
      };
};

const priceLookups = (resolution: ExactPriceResolution): readonly ExactPriceLookupResult[] =>
  Match.value(resolution.path).pipe(
    Match.tag('CONFIGURATION_ERROR', ({ lookup }) => (lookup === undefined ? [] : [lookup])),
    Match.tag('CONFLICT', ({ lookup }) => (lookup === undefined ? [] : [lookup])),
    Match.tag('GROUP_PRICE', ({ usedPrice }) => [usedPrice]),
    Match.tag('INDETERMINATE', ({ lookup }) => (lookup === undefined ? [] : [lookup])),
    Match.tag('NO_APPLICABLE_PRICE', ({ groupAbsence, noGroupAbsence }) =>
      groupAbsence === undefined ? [noGroupAbsence] : [groupAbsence, noGroupAbsence],
    ),
    Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', ({ groupAbsence, usedPrice }) => [groupAbsence, usedPrice]),
    Match.tag('NO_GROUP_GUEST', ({ usedPrice }) => [usedPrice]),
    Match.tag('NO_GROUP_NONE', ({ usedPrice }) => [usedPrice]),
    Match.exhaustive,
  );

const publicLookup = (lookup: ExactPriceOwnerLookupResult): ExactPriceLookupResult =>
  Schema.is(ExactPriceConflictDiagnosticSchema)(lookup) ? redactExactPriceConflictDiagnostic(lookup) : lookup;

const sameLookup = Schema.toEquivalence(ExactPriceLookupResultSchema);
const MaterialExactPriceLookupSchema = Schema.Union([ExactPriceLookupAbsentSchema, ExactPriceLookupFoundSchema]);
const isMaterialPriceLookup = Schema.is(MaterialExactPriceLookupSchema);
const isAbsentPriceLookup = Schema.is(ExactPriceLookupAbsentSchema);
const isFoundPriceLookup = Schema.is(ExactPriceLookupFoundSchema);

const priceCandidateSetAuthorities = (
  resolution: ExactPriceResolution,
  persistence: Pick<ExactPriceCandidateSetPersistence, 'readExactCandidateSet'>,
): Effect.Effect<readonly PricingExactPriceOwnerReadReceipt[], CurrentPricingDecisionOwnerReadFailure> =>
  Effect.forEach(
    priceLookups(resolution),
    (lookup) => {
      if (
        Schema.is(ExactPriceLookupInvalidSchema)(lookup) ||
        Schema.is(ExactPriceLookupUnavailableSchema)(lookup) ||
        Schema.is(ExactPriceLookupUnverifiableSchema)(lookup)
      ) {
        return Effect.succeed<Option.Option<PricingExactPriceOwnerReadReceipt>>(Option.none());
      }
      return persistence
        .readExactCandidateSet({ effectiveAt: lookup.request.effectiveAt, exactKey: lookup.request.exactKey })
        .pipe(
          Effect.mapError(unavailable(EXACT_PRICE_OWNER_REF, 'Exact Price candidate-set authority is unavailable')),
          Effect.flatMap((outcome) => {
            if (outcome.outcome === 'EXACT_PRICE_CANDIDATE_SET_UNVERIFIABLE') {
              return Effect.fail(
                failure('UNVERIFIABLE', EXACT_PRICE_OWNER_REF, 'Exact Price candidate-set authority is unverifiable'),
              );
            }
            const reread = publicLookup(ownerLookupFromCandidateSet(lookup.request, outcome));
            return sameLookup(reread, lookup)
              ? Effect.succeedSome({
                  authority: outcome.authority,
                  factProofs: 'factProofs' in outcome ? outcome.factProofs : [],
                })
              : Effect.fail(
                  failure(
                    'UNVERIFIABLE',
                    EXACT_PRICE_OWNER_REF,
                    'Exact Price resolution does not match its transaction-scoped candidate-set authority',
                  ),
                );
          }),
        );
    },
    { concurrency: 2 },
  ).pipe(Effect.map((authorities) => authorities.flatMap(Option.toArray)));

/** Deterministic seam used by production with transaction-scoped owner ports and by focused contract tests. */
export const makeCurrentPricingDecisionAttemptSource = (
  ports: CurrentPricingDecisionAttemptSourcePorts,
): CurrentPricingDecisionAttemptSourcePort => ({
  loadFresh: Effect.fn('CurrentPricingDecisionAttemptSource.loadFresh')(function* loadFresh(request, trusted, ordinal) {
    if (
      request.decision.tenantId !== trusted.tenantId ||
      request.decision.commercialScope.sellingLegalEntityId !== trusted.sellingLegalEntityId
    ) {
      return yield* failure(
        'UNVERIFIABLE',
        'pricing-current-decision:trusted-scope',
        'Request is outside trusted Tenant or SLE',
      );
    }
    const support = yield* resolveCurrentSupportedCurrencies(
      { effectiveAt: request.decision.operationTime, tenantId: trusted.tenantId },
      { tenantId: trusted.tenantId },
      ports.loadCurrencySupport,
    ).pipe(Effect.mapError(unavailable(CURRENCY_SUPPORT_OWNER_REF, 'Currency Support owner is unavailable')));
    if (!Schema.is(CurrentSupportedCurrenciesSuccessSchema)(support)) {
      return yield* failure(
        support.outcome === 'SUPPORTED_CURRENCIES_INVALID' ? 'CONFIGURATION' : 'UNAVAILABLE',
        CURRENCY_SUPPORT_OWNER_REF,
        'reason' in support ? support.reason : support.outcome,
      );
    }
    const currencyEvidence = Option.getOrUndefined(supportEvidence(support, request.decision.currencyCode));
    if (currencyEvidence === undefined) {
      return yield* failure(
        'UNVERIFIABLE',
        CURRENCY_SUPPORT_OWNER_REF,
        'Currency Support owner receipt omitted its exact fact proof',
      );
    }
    const trustedOperationAt = DateTime.makeUnsafe(request.decision.operationTime);
    const buildSourceLine = Effect.fn('CurrentPricingDecisionAttemptSource.buildSourceLine')(
      function* buildSourceLineProgram(line: (typeof request.decision.lines)[number]) {
        const resolutionInput = yield* fallbackInput(request, line, ports.interpreter);
        const exactPriceInput = { currencySupport: support, resolutionInput };
        const exactPriceTrustedContext = {
          legalEntityId: trusted.sellingLegalEntityId,
          tenantId: trusted.tenantId,
          trustedOperationAt,
        };
        const exactPrice = yield* ports.exactPrice.resolve(exactPriceInput, exactPriceTrustedContext);
        const priceAuthorities = yield* priceCandidateSetAuthorities(exactPrice, ports.priceCandidateSets);
        if (!Schema.is(ExactPriceFoundResolutionSchema)(exactPrice)) {
          return {
            exactPrice,
            source: {
              exactPrice,
              exactPriceInput,
              exactPriceTrustedContext,
              line,
              priceCandidateSetAuthorities: priceAuthorities,
            },
          };
        }
        if (!('usedPrice' in exactPrice.path)) {
          return yield* failure('UNVERIFIABLE', EXACT_PRICE_OWNER_REF, 'PRICE_FOUND omitted its exact owner Price');
        }
        const { usedPrice } = exactPrice.path;
        const targetRef = line.catalog.selection.packageOption?.optionRef ?? line.catalog.selection.variantRef;
        const ownerDecision = yield* ports.catalogQuantity
          .assess({
            effectiveAt: request.decision.operationTime,
            handoff: line.catalog,
            price: {
              quantity: line.pricingBasis.quantity,
              quantityBasis: { ...line.catalog.quantityBasis, targetRef, unitRef: line.pricingBasis.unitRef },
            },
          })
          .pipe(
            Effect.mapError(unavailable('catalog:quantity-basis', 'Catalog Quantity-basis authority is unavailable')),
          );
        const quantityBasis = yield* assessPricingQuantityBasis({
          attempt: {
            catalog: line.catalog,
            effectiveAt: request.decision.operationTime,
            occurrenceId: line.occurrenceId,
            price: {
              identityKey: usedPrice.request.exactKey,
              priceRef: usedPrice.priceRef,
              revision: usedPrice.priceRevision,
            },
          },
          ownerDecision,
        });
        const source =
          (quantityBasis.outcome === 'NO_CONVERSION_REQUIRED' || quantityBasis.outcome === 'COMPATIBLE_CONVERSION') &&
          (ownerDecision.outcome === 'NO_CONVERSION_REQUIRED' || ownerDecision.outcome === 'COMPATIBLE_CONVERSION')
            ? {
                exactPrice,
                exactPriceInput,
                exactPriceTrustedContext,
                line,
                lineQuantity: {
                  quantity:
                    ownerDecision.outcome === 'COMPATIBLE_CONVERSION'
                      ? (ownerDecision.steps.find(({ from, to }) => from === 'PURCHASE' && to === 'PRICE')
                          ?.toQuantity ?? quantityBasis.resultingPurchaseQuantity.amount)
                      : quantityBasis.resultingPurchaseQuantity.amount,
                  quantityBasis: {
                    catalogQuantityBasis: ownerDecision.endpoints.price.quantityBasis,
                    priceUnitBasis: usedPrice.request.exactKey.unitBasis,
                  },
                },
                priceCandidateSetAuthorities: priceAuthorities,
                quantityBasis,
              }
            : {
                exactPrice,
                exactPriceInput,
                exactPriceTrustedContext,
                line,
                priceCandidateSetAuthorities: priceAuthorities,
                quantityBasis,
              };
        return { exactPrice, source };
      },
    );
    const lines = yield* Effect.forEach(request.decision.lines, buildSourceLine, { concurrency: 16 });
    const candidateRef = `pricing-current:${request.decision.tenantId}:${request.decision.purchasingContext.contextRef}:${request.decision.purchasingContext.contextRevision}`;
    const runId = `${candidateRef}:run:${request.decision.operationTime}`;
    const attemptId = `${runId}:attempt:${ordinal}`;
    const attempt = yield* Schema.decodeEffect(PricingEvaluationAttemptSchema, { onExcessProperty: 'error' })({
      attemptId,
      attemptOrdinal: ordinal,
      candidateRef,
      completedAt: support.observedAt,
      maxAttempts: 2,
      runId,
      snapshot: {
        attemptId,
        calculationVersions: {
          allocationContractVersions: [PRICING_ALLOCATION_CONTRACT_VERSION],
          arithmeticProfileVersions: ['pricing-arithmetic:v1'],
          publicationProfileVersions: ['pricing-publication:v1'],
        },
        candidateRef,
        capturedAt: support.observedAt,
        decision: request.decision,
        materialBindings: [
          {
            bindingRef: CURRENCY_SUPPORT_OWNER_REF,
            kind: 'CURRENCY_SUPPORT',
            meaningRef: support.supportRevisionRef.resourceId,
            sourceEvidence: currencyEvidence,
          },
        ],
        requestedAt: request.decision.operationTime,
        snapshotId: `${attemptId}:snapshot`,
      },
      startedAt: request.decision.operationTime,
    }).pipe(
      Effect.mapError((cause) =>
        failure('UNVERIFIABLE', 'pricing-current-decision:whole-attempt-source', 'Owner snapshot is invalid', cause),
      ),
    );
    const [first, ...rest] = lines;
    if (first === undefined) {
      return yield* failure(
        'CONFIGURATION',
        'pricing-current-decision:whole-attempt-source',
        'Candidate has no stable lines',
      );
    }
    return {
      attempt,
      exactPriceLines: [first.source, ...rest.map(({ source }) => source)],
      requiredOwnerRefs: [
        `pricing-currency-support:${support.supportRootRef.resourceId}`,
        ...request.decision.lines.map(({ catalog }) => `catalog:${catalog.ownerRevision}`),
        ...lines.map(({ exactPrice }) =>
          Schema.is(ExactPriceFoundResolutionSchema)(exactPrice) && 'usedPrice' in exactPrice.path
            ? `pricing-price:${exactPrice.path.usedPrice.priceRef.resourceId}`
            : EXACT_PRICE_OWNER_REF,
        ),
      ],
    };
  }),
});

const exactPredicate = (key: PriceIdentityKey): string => {
  const selector =
    key.priceGroupSelector.kind === 'NO_GROUP' ? 'none' : key.priceGroupSelector.priceGroupRef.resourceId;
  return [
    'pricing-exact-price',
    key.catalogSelection.productRef.tenantId,
    key.catalogSelection.variantRef.resourceId,
    key.commercialScope.sellingLegalEntityId,
    key.commercialScope.channelId,
    key.commercialScope.marketId,
    key.currencyCode,
    key.unitBasis.unitRef.resourceId,
    key.unitBasis.quantity,
    selector,
  ]
    .map(encodeURIComponent)
    .join(':');
};

const tierReaderFor = (
  persistence: QuantityTierPersistence,
  prices: PricePersistence,
  catalogEquivalence: CatalogPricingPurposeEquivalencePort,
): CurrentPricingDecisionTierSetReaderPort => ({
  loadCurrent: (request, attemptSnapshot, line, exactPrice, aggregationGroup) => {
    if (!Schema.is(ExactPriceFoundResolutionSchema)(exactPrice) || line.lineQuantity === undefined) {
      return Effect.fail(
        failure(
          'UNVERIFIABLE',
          QUANTITY_TIER_OWNER_REF,
          'Tier input lacks exact Price or normalized Quantity evidence',
        ),
      );
    }
    if (!('usedPrice' in exactPrice.path)) {
      return Effect.fail(failure('UNVERIFIABLE', EXACT_PRICE_OWNER_REF, 'Found Price omitted its exact owner Price'));
    }
    const { usedPrice } = exactPrice.path;
    const authorityReads = Effect.all(
      {
        priceSchedule: prices.readSchedule(
          usedPrice.priceRef,
          DateTime.toDate(DateTime.makeUnsafe(usedPrice.request.effectiveAt)),
        ),
        tierSet: persistence.readCurrentSet({
          effectiveAt: usedPrice.request.effectiveAt,
          priceRef: usedPrice.priceRef,
        }),
      },
      { concurrency: 2 },
    );
    const aggregateAndReadTierSet = Effect.fn('CurrentPricingDecisionTierSetReader.aggregateAndReadTierSet')(
      function* aggregateAndReadTierSetProgram({ priceSchedule, tierSet }: Effect.Success<typeof authorityReads>) {
        if (priceSchedule.outcome !== 'PRICE_SCHEDULE_CURRENT' || priceSchedule.schedule.current === undefined) {
          return yield* failure('UNVERIFIABLE', 'pricing-price:schedule', 'Exact Price schedule is not Current');
        }
        const exactPriceEffect = {
          path: { priceGroupSelector: usedPrice.request.exactKey.priceGroupSelector, requiredAbsenceEvidence: [] },
          price: priceSchedule.schedule.current,
          scheduleRevision: priceSchedule.schedule.scheduleRevision,
        };
        const participants = aggregationGroup.flatMap(({ exactPrice: participantPrice, line: participantLine }) => {
          if (
            participantLine.lineQuantity === undefined ||
            !Schema.is(ExactPriceFoundResolutionSchema)(participantPrice) ||
            !('usedPrice' in participantPrice.path)
          ) {
            return [];
          }
          return [
            {
              candidateRef: attemptSnapshot.candidateRef,
              exactPrice: exactPriceEffect,
              line: participantLine.line,
              normalizedQuantity: participantLine.lineQuantity,
            },
          ];
        });
        const aggregationAttempt: QuantityTierAggregationAttempt = {
          candidate: request.decision,
          candidateRef: attemptSnapshot.candidateRef,
          evaluatedAt: usedPrice.request.effectiveAt,
          participants,
        };
        const [singleParticipant] = participants;
        const aggregatedQuantity =
          participants.length === 1 && singleParticipant !== undefined
            ? singleParticipant.normalizedQuantity
            : yield* catalogEquivalence.resolve(aggregationAttempt).pipe(
                Effect.mapError(
                  unavailable(
                    'catalog:pricing-purpose-equivalence',
                    'Catalog Pricing-purpose equivalence is unavailable',
                  ),
                ),
                Effect.flatMap((resolution) =>
                  aggregateQuantityTierLines({ attempt: aggregationAttempt, catalogEquivalence: resolution }),
                ),
                Effect.flatMap((result) =>
                  result.outcome === 'QUANTITY_TIER_QUANTITY_AGGREGATED'
                    ? Effect.succeed(result.aggregatedQuantity)
                    : Effect.fail(
                        failure(
                          'UNVERIFIABLE',
                          'pricing-quantity-tier:aggregation',
                          `Quantity Tier aggregation was refused: ${result.reason}`,
                        ),
                      ),
                ),
              );
        const selectionAttempt: QuantityTierSelectionAttempt = {
          evaluatedAt: usedPrice.request.effectiveAt,
          exactPrice: exactPriceEffect,
          normalizedQuantity: aggregatedQuantity,
          tierSetPriceRef: usedPrice.priceRef,
        };
        if (tierSet.outcome === 'QUANTITY_TIER_SET_CURRENT') {
          return {
            authority: tierSet.authority,
            request: {
              input: { attempt: selectionAttempt, tierSet: tierSet.tierSet },
              outcome: 'TIER_SET_CURRENT' as const,
            },
          };
        }
        if (tierSet.outcome === 'QUANTITY_TIER_SET_PRICE_ABSENT') {
          return yield* failure(
            'UNVERIFIABLE',
            QUANTITY_TIER_OWNER_REF,
            'Price absence does not prove Tier-set absence',
          );
        }
        return yield* failure('UNVERIFIABLE', QUANTITY_TIER_OWNER_REF, 'Tier-set authority is unavailable');
      },
    );
    return authorityReads.pipe(
      Effect.mapError(unavailable(QUANTITY_TIER_OWNER_REF, 'Tier or Price schedule authority is unavailable')),
      Effect.flatMap(aggregateAndReadTierSet),
    );
  },
});

const foundFromUnitPrice = (unitPrice: Parameters<CurrentPricingDecisionFeeSetReaderPort['loadCurrent']>[2]) =>
  'usedPrice' in unitPrice.input.exactPrice.path ? unitPrice.input.exactPrice.path.usedPrice : undefined;

const makeFeeReader = (persistence: CommercialFeePersistence): CurrentPricingDecisionFeeSetReaderPort => ({
  loadCurrent: (request, _attempt, unitPrice) =>
    persistence
      .readCurrentSet({
        commercialScope: request.decision.commercialScope,
        currencyCode: request.decision.currencyCode,
        effectiveAt: request.decision.operationTime,
        target: { variantRef: unitPrice.input.line.catalog.selection.variantRef },
      })
      .pipe(
        Effect.mapError(unavailable('pricing-commercial-fee:current-set', 'Commercial Fee authority is unavailable')),
        Effect.flatMap((result) => {
          if (result.outcome !== 'COMMERCIAL_FEE_SET_CURRENT') {
            return Effect.fail(
              failure(
                result.outcome === 'COMMERCIAL_FEE_SET_CONFLICT' ? 'CONFLICT' : 'UNVERIFIABLE',
                'pricing-commercial-fee:current-set',
                result.outcome,
              ),
            );
          }
          const found = foundFromUnitPrice(unitPrice);
          if (found === undefined) {
            return Effect.fail(failure('UNVERIFIABLE', EXACT_PRICE_OWNER_REF, 'Unit Price lost exact Price evidence'));
          }
          const decision =
            unitPrice.input.tierSelection.outcome === 'QUANTITY_TIER_APPLIED'
              ? unitPrice.input.tierSelection.evidence.decision
              : undefined;
          const winningTier = decision?.kind === 'HIGHEST_REACHED_THRESHOLD' ? decision.winningTier : undefined;
          const feeInput = {
            baseLineValue: unitPrice.baseLineValue,
            currencySupport: unitPrice.input.exactPrice.currencySupport,
            decision: request.decision,
            feeSet: result.feeSet,
            occurrenceId: unitPrice.input.line.occurrenceId,
            pricePath: {
              priceRef: found.priceRef,
              priceRevisionId: found.priceRevision.revisionId,
              source:
                found.request.exactKey.priceGroupSelector.kind === 'NO_GROUP'
                  ? ('NO_GROUP_PRICE' as const)
                  : ('PRICE_GROUP_PRICE' as const),
            },
          };
          if (winningTier !== undefined) {
            Object.assign(feeInput, { quantityTierRevisionId: winningTier.definition.revision.revisionId });
          }
          return Effect.succeed({
            authority: result.authority,
            factProofs: result.factProofs,
            input: feeInput,
          });
        }),
      ),
});

const sameDiscountBasis = Schema.toEquivalence(PricingDiscountIdentityBasisSchema);
const sameDiscountIdentity = Schema.toEquivalence(PricingDiscountIdentityKeySchema);

const discountBasisFor = (unitPrice: Parameters<CurrentPricingDecisionFeeSetReaderPort['loadCurrent']>[2]) => {
  const found = foundFromUnitPrice(unitPrice);
  return found === undefined
    ? undefined
    : {
        catalogSelection: found.request.exactKey.catalogSelection,
        kind: 'VARIANT_LINE' as const,
        unitBasis: found.request.exactKey.unitBasis,
      };
};

const discountBasePricePathFor = (unitPrice: Parameters<CurrentPricingDecisionFeeSetReaderPort['loadCurrent']>[2]) => {
  const found = foundFromUnitPrice(unitPrice);
  if (found === undefined) {
    return null;
  }
  const selector = found.request.exactKey.priceGroupSelector;
  const base = { priceRef: found.priceRef, priceRevisionId: found.priceRevision.revisionId };
  return selector.kind === 'NO_GROUP'
    ? { ...base, kind: 'NO_GROUP_PRICE' as const }
    : { ...base, kind: 'PRICE_GROUP_PRICE' as const, priceGroupRef: selector.priceGroupRef };
};

const assignedDiscountAudienceFor = (
  unitPrice: Parameters<CurrentPricingDecisionFeeSetReaderPort['loadCurrent']>[2],
) => {
  const { resolutionInput } = unitPrice.input.exactPrice.path;
  return Match.value(resolutionInput).pipe(
    Match.tag('ASSIGNED', (assigned) => {
      const audience = { kind: 'PRICE_GROUP' as const, priceGroupRef: assigned.interpretation.priceGroupRef };
      return Option.some({
        audience,
        evidence: {
          audience,
          interpretation: assigned.interpretation,
          kind: 'PRICE_GROUP_OWNER_EVIDENCE' as const,
        },
      });
    }),
    Match.orElse(() => Option.none()),
    Option.getOrUndefined,
  );
};

const makeDiscountReader = (
  persistence: ContractualDiscountPersistence,
): CurrentPricingDecisionDiscountSetReaderPort => ({
  loadCurrent: ({ request, unitPrices }) => {
    if (request.subject.kind === 'GUEST') {
      return Effect.succeed({ applicabilityInputs: [], currentSets: [] });
    }
    if (request.subject.authorizationSubject.kind === 'COUNTERPARTY') {
      return Effect.fail(
        failure(
          'UNVERIFIABLE',
          'party.registry:counterparty-discount-audience',
          'Counterparty Discount applicability requires retained Party owner Revision evidence',
        ),
      );
    }
    const assignedLines = unitPrices.map((unitPrice) => ({
      assigned: assignedDiscountAudienceFor(unitPrice),
      basePricePath: discountBasePricePathFor(unitPrice),
      basis: discountBasisFor(unitPrice),
      unitPrice,
    }));
    const assignedCount = assignedLines.filter(({ assigned }) => assigned !== undefined).length;
    if (assignedCount === 0) {
      return Effect.succeed({ applicabilityInputs: [], currentSets: [] });
    }
    if (assignedCount !== assignedLines.length) {
      return Effect.fail(
        failure(
          'UNVERIFIABLE',
          DISCOUNT_OWNER_REF,
          'One whole Pricing decision cannot mix assigned and unassigned Discount audiences',
        ),
      );
    }
    const [firstAssignedLine] = assignedLines;
    if (
      firstAssignedLine?.assigned === undefined ||
      firstAssignedLine.basePricePath === null ||
      firstAssignedLine.basis === undefined
    ) {
      return Effect.fail(
        failure('UNVERIFIABLE', DISCOUNT_OWNER_REF, 'Discount applicability lost the first exact assigned Price basis'),
      );
    }
    const groupRef = firstAssignedLine.assigned.audience.priceGroupRef;
    if (
      assignedLines.some(
        ({ assigned }) =>
          assigned === undefined ||
          assigned.audience.priceGroupRef.moduleId !== groupRef.moduleId ||
          assigned.audience.priceGroupRef.resourceId !== groupRef.resourceId ||
          assigned.audience.priceGroupRef.resourceType !== groupRef.resourceType ||
          assigned.audience.priceGroupRef.tenantId !== groupRef.tenantId,
      )
    ) {
      return Effect.fail(
        failure(
          'CONFLICT',
          'commerce-customer-context:price-group-assignment',
          'Whole-purchase Discount cannot combine different assigned Price Groups',
        ),
      );
    }
    const descriptors = assignedLines.map(({ assigned, basePricePath, basis, unitPrice }) => ({
      assigned,
      basePricePath,
      basis,
      unitPrice,
    }));
    type DiscountCurrentSet = Effect.Success<ReturnType<typeof persistence.readCurrentSet>>;
    type DiscountDescriptor = (typeof descriptors)[number];
    const resolveRevision = Effect.fn('CurrentPricingDecisionDiscountSetReader.resolveRevision')(
      function* resolveRevisionProgram(input: {
        readonly assigned: NonNullable<DiscountDescriptor['assigned']>;
        readonly basePricePath: Exclude<DiscountDescriptor['basePricePath'], null>;
        readonly currentSet: DiscountCurrentSet;
        readonly revision: DiscountCurrentSet['currentDiscounts'][number];
        readonly unitPrice: DiscountDescriptor['unitPrice'];
      }) {
        const { assigned, basePricePath, currentSet, revision, unitPrice } = input;
        const currentResolution = yield* resolveCurrentPricingDiscountRevisions(
          revision.definition.identityKey,
          [revision],
          request.decision.operationTime,
        ).pipe(
          Effect.mapError((cause) =>
            failure(
              'UNVERIFIABLE',
              DISCOUNT_OWNER_REF,
              'Contractual Discount Current-set could not preserve its exact logical identity',
              cause,
            ),
          ),
        );
        return {
          audienceBinding: {
            applicabilityBasis: {
              basis: revision.definition.identityKey.basis,
              commercialScope: request.decision.commercialScope,
              currencyCode: request.decision.currencyCode,
              observedAt: currentSet.authority.observedAt,
            },
            basePricePath,
            evidence: assigned.evidence,
            identityKey: revision.definition.identityKey,
          },
          currencySupport: unitPrice.input.exactPrice.currencySupport,
          currentResolution,
        };
      },
    );
    const readDescriptor = Effect.fn('CurrentPricingDecisionDiscountSetReader.readDescriptor')(
      function* readDescriptorProgram({ assigned, basePricePath, basis, unitPrice }: (typeof descriptors)[number]) {
        if (assigned === undefined || basis === undefined || basePricePath === null) {
          return yield* failure(
            'UNVERIFIABLE',
            DISCOUNT_OWNER_REF,
            'Discount applicability lost the exact Price basis used by the line',
          );
        }
        const predicate = {
          audiences: [assigned.audience],
          basis,
          commercialScope: request.decision.commercialScope,
          currencyCode: request.decision.currencyCode,
          effectiveAt: request.decision.operationTime,
          tenantId: request.decision.tenantId,
        };
        const currentSet = yield* persistence
          .readCurrentSet(predicate)
          .pipe(Effect.mapError(unavailable(DISCOUNT_OWNER_REF, 'Contractual Discount authority is unavailable')));
        const applicabilityInputs = yield* Effect.forEach(
          currentSet.currentDiscounts,
          (revision) => resolveRevision({ assigned, basePricePath, currentSet, revision, unitPrice }),
          { concurrency: 16 },
        );
        return { applicabilityInputs, currentSets: [currentSet] };
      },
    );
    return Effect.forEach(descriptors, readDescriptor, { concurrency: 16 }).pipe(
      Effect.map((reads) => ({
        applicabilityInputs: reads.flatMap(({ applicabilityInputs }) => applicabilityInputs),
        currentSets: reads.flatMap(({ currentSets }) => currentSets),
      })),
    );
  },
});

const discountCandidate = (
  applicability: PricingDiscountApplicability,
  request: CurrentPricingDecisionRequest,
  unitPrices: readonly Parameters<CurrentPricingDecisionFeeSetReaderPort['loadCurrent']>[2][],
) => {
  if (applicability.outcome !== 'DISCOUNT_APPLICABLE') {
    return null;
  }
  const { definition } = applicability;
  const { identityKey } = definition;
  const audienceBinding = {
    applicabilityBasis: {
      basis: identityKey.basis,
      commercialScope: identityKey.commercialScope,
      currencyCode: identityKey.currencyCode,
      observedAt: request.decision.operationTime,
    },
    basePricePath: applicability.basePricePath,
    evidence: applicability.evidence,
    identityKey,
  };
  if (applicability.applicationCount === 'ONCE_PER_PRICING_DECISION') {
    if (applicability.applicability.outcome !== 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE') {
      return null;
    }
    return {
      applicability: applicability.applicability,
      applicationCount: applicability.applicationCount,
      audienceBinding,
      decision: request.decision,
      definition,
      kind: 'WHOLE_PURCHASE' as const,
      layer: 'COUNTERPARTY_WHOLE_PURCHASE' as const,
      outcome: applicability.outcome,
    };
  }
  const unitPrice = unitPrices.find((candidate) => {
    const basis = discountBasisFor(candidate);
    return basis !== undefined && sameDiscountBasis(basis, identityKey.basis);
  });
  if (unitPrice === undefined) {
    return null;
  }
  let layer: 'CATALOG' | 'COUNTERPARTY_CONTRACTUAL' | 'PRICE_GROUP_CONTRACTUAL';
  if (identityKey.audience.kind === 'CATALOG_PATH') {
    layer = 'CATALOG';
  } else if (identityKey.audience.kind === 'PRICE_GROUP') {
    layer = 'PRICE_GROUP_CONTRACTUAL';
  } else {
    layer = 'COUNTERPARTY_CONTRACTUAL';
  }
  return {
    applicationCount: applicability.applicationCount,
    audienceBinding,
    definition,
    kind: 'VARIANT_LINE' as const,
    layer,
    occurrenceId: unitPrice.input.line.occurrenceId,
    outcome: applicability.outcome,
  };
};

const stableSortedSet = (values: readonly string[]): readonly string[] => [...new Set(values)].toSorted();

const allEqualTo = <T>(expected: T, values: readonly T[]): boolean => values.every((value) => value === expected);

const zeroFloorAudienceRefs = (
  request: CurrentPricingDecisionRequest,
  line: Parameters<CurrentPricingDecisionZeroFloorSetReaderPort['loadCurrent']>[2]['lines'][number],
): readonly string[] => {
  const { path } = line.unitPriceCalculation.input.exactPrice;
  const priceGroupRef =
    'discountAudience' in path && path.discountAudience.kind === 'PRICE_GROUP'
      ? path.discountAudience.priceGroupRef.resourceId
      : undefined;
  return stableSortedSet([
    request.decision.purchasingContext.contextRef,
    request.decision.purchasingContext.contextRevision,
    ...(priceGroupRef === undefined ? [] : [priceGroupRef]),
  ]);
};

const zeroFloorMaterialRevisionRefs = (
  line: Parameters<CurrentPricingDecisionZeroFloorSetReaderPort['loadCurrent']>[2]['lines'][number],
): readonly string[] | undefined => {
  const { path } = line.unitPriceCalculation.input.exactPrice;
  if (!('usedPrice' in path)) {
    return undefined;
  }
  const tierDecision = line.unitPriceCalculation.input.tierSelection.evidence.decision;
  const tierRevision =
    line.unitPriceCalculation.input.tierSelection.outcome === 'QUANTITY_TIER_APPLIED' &&
    tierDecision.kind === 'HIGHEST_REACHED_THRESHOLD'
      ? tierDecision.winningTier.definition.revision.revisionId
      : undefined;
  return stableSortedSet([
    path.usedPrice.priceRevision.revisionId,
    ...(tierRevision === undefined ? [] : [tierRevision]),
    ...line.feeCalculation.contributions.map(({ fee }) => fee.definition.revision.revisionId),
    ...line.lineDiscountContributions.map(({ candidate }) => candidate.definition.revision.revisionId),
    ...(line.wholePurchaseAllocationRevisionRef === undefined ? [] : [line.wholePurchaseAllocationRevisionRef]),
    ...(line.promotionOwnerDecisionRevision === undefined ? [] : [line.promotionOwnerDecisionRevision]),
  ]);
};

export const makeCurrentPricingDecisionZeroFloorSetReader = (
  persistence: ZeroFloorAuthorizationPersistence,
): CurrentPricingDecisionZeroFloorSetReaderPort => ({
  loadCurrent: (request, _attempt, composition) => {
    if (
      composition.lines.length !== request.decision.lines.length ||
      !Schema.toEquivalence(PricingDecisionSchema)(composition.decision, request.decision)
    ) {
      return Effect.fail(
        failure(
          'UNVERIFIABLE',
          'pricing-zero-floor:current-set',
          'ZERO_FLOOR owner reads require the exact ordered Pricing candidate',
        ),
      );
    }
    return Effect.forEach(
      composition.lines,
      (composedLine, index) => {
        const decisionLine = request.decision.lines[index];
        const materialRevisionRefs = zeroFloorMaterialRevisionRefs(composedLine);
        if (decisionLine?.occurrenceId !== composedLine.occurrenceId || materialRevisionRefs === undefined) {
          return Effect.fail(
            failure(
              'UNVERIFIABLE',
              EXACT_PRICE_OWNER_REF,
              'ZERO_FLOOR input lost an ordered stable line or exact Price Revision',
            ),
          );
        }
        const query = {
          audienceRefs: zeroFloorAudienceRefs(request, composedLine),
          catalogSelection: composedLine.line.catalog.selection,
          commercialScope: request.decision.commercialScope,
          currencyCode: request.decision.currencyCode,
          effectiveAt: request.decision.operationTime,
          exactPredicateRef: `pricing-zero-floor:${request.decision.tenantId}:${composition.candidateRef}:${composedLine.occurrenceId}`,
          materialRevisionRefs,
          pricingBasis: decisionLine.pricingBasis,
          tenantId: request.decision.tenantId,
        };
        return persistence.readCurrentSet({ query }).pipe(
          Effect.mapError(unavailable('pricing-zero-floor:current-set', 'ZERO_FLOOR authority is unavailable')),
          Effect.map(({ authority, authorizationSet, factProofs }) => ({
            authority,
            authorizationSet,
            factProofs,
            occurrenceId: composedLine.occurrenceId,
          })),
        );
      },
      { concurrency: 16 },
    );
  },
});

const completeness = (
  result: Extract<ExactPriceLookupResult, { readonly _tag: 'ABSENT' | 'FOUND' }>,
  key: PriceIdentityKey,
) => {
  const evidence = {
    observedAt: result.evidence.observedAt,
    ownerRevision: result.evidence.ownerRevision,
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: exactPredicate(key) },
  };
  if (result.evidence.nextApplicabilityBoundary !== undefined) {
    Object.assign(evidence, { nextApplicabilityBoundary: result.evidence.nextApplicabilityBoundary });
  }
  return evidence;
};

const legacyKey = (key: PriceIdentityKey) => ({
  commercialScope: key.commercialScope,
  currencyCode: key.currencyCode,
  exactPredicateRef: exactPredicate(key),
  groupSelector:
    key.priceGroupSelector.kind === 'NO_GROUP'
      ? { kind: 'NO_GROUP' as const }
      : { kind: 'ASSIGNED_GROUP' as const, priceGroupRef: key.priceGroupSelector.priceGroupRef.resourceId },
  pricingBasis: key.unitBasis,
  selection: key.catalogSelection,
});

const priceReceiptBindsLookup = (
  receipt: PricingExactPriceOwnerReadReceipt,
  lookup: Extract<ExactPriceLookupResult, { readonly _tag: 'ABSENT' | 'FOUND' }>,
): boolean => {
  const { authority, factProofs } = receipt;
  if (
    authority.observedAt !== lookup.evidence.observedAt ||
    authority.ownerRevision !== lookup.evidence.ownerRevision ||
    authority.nextApplicabilityBoundary !== lookup.evidence.nextApplicabilityBoundary ||
    authority.predicateRef !== exactPredicate(lookup.request.exactKey)
  ) {
    return false;
  }
  if (isAbsentPriceLookup(lookup)) {
    return factProofs.length === 0;
  }
  return (
    factProofs.length === 1 &&
    factProofs[0]?.factRef === lookup.priceRef.resourceId &&
    factProofs[0]?.factRevisionRef === lookup.priceRevision.revisionId &&
    factProofs[0]?.verificationRef === authority.verificationRef
  );
};

const exactPriceLineHasCompleteReceipts = (line: {
  readonly exactPrice: ExactPriceResolution;
  readonly priceCandidateSetAuthorities: readonly PricingExactPriceOwnerReadReceipt[];
}): boolean => {
  const materialLookups = priceLookups(line.exactPrice).filter(isMaterialPriceLookup);
  return (
    materialLookups.length > 0 &&
    materialLookups.length === line.priceCandidateSetAuthorities.length &&
    materialLookups.every((lookup, index) => {
      const receipt = line.priceCandidateSetAuthorities[index];
      return receipt !== undefined && priceReceiptBindsLookup(receipt, lookup);
    })
  );
};

type ComparablePricingDecisionSubject =
  | CurrentPricingDecisionRequest['subject']
  | CurrentPricingDecisionSubjectAuthorityEvidence['subjectAuthority']['subject'];

const sameSubject = (left: ComparablePricingDecisionSubject, right: ComparablePricingDecisionSubject): boolean => {
  const decodedLeft = Schema.decodeUnknownOption(PricingDecisionSubjectSchema)(left);
  const decodedRight = Schema.decodeUnknownOption(PricingDecisionSubjectSchema)(right);
  return (
    Option.isSome(decodedLeft) &&
    Option.isSome(decodedRight) &&
    Schema.toEquivalence(PricingDecisionSubjectSchema)(decodedLeft.value, decodedRight.value)
  );
};

type DiscountNonSelection = Extract<
  PricingMaterialDiscountSelection,
  { readonly kind: 'DISCOUNT_NOT_SELECTED_NO_ELIGIBLE_AUDIENCE' }
>;

const discountSubjectEvidenceFor = (evidence: CurrentPricingDecisionSubjectAuthorityEvidence) => ({
  currentness: evidence.currentness,
  ownerRef: evidence.ownerRef,
  ownerRevisionRef: evidence.ownerRevisionRef,
  subjectAuthority: evidence.subjectAuthority,
  verificationRef: evidence.verificationRef,
});

export type CurrentPricingDiscountNonSelectionResolution =
  | { readonly kind: 'DISCOUNT_AUDIENCE_SELECTED' }
  | { readonly kind: 'DISCOUNT_NOT_SELECTED'; readonly selection: DiscountNonSelection };

export interface BuildCurrentPricingDiscountNonSelectionInput {
  readonly commercialTotal: PricingMaterialEvidenceAssemblyRequest['commercialTotal'];
  readonly request: CurrentPricingDecisionRequest;
  readonly subjectEvidence: CurrentPricingDecisionSubjectAuthorityEvidence;
}

/**
 * Derives the explicit no-audience Discount decision from the exact CCC proof and retained Price
 * path. This records audience nonselection only; it never claims that Discount facts are absent.
 */
export const buildCurrentPricingDiscountNonSelection = (
  input: BuildCurrentPricingDiscountNonSelectionInput,
): Effect.Effect<CurrentPricingDiscountNonSelectionResolution, CurrentPricingDecisionOwnerReadFailure> => {
  const { commercialTotal, request, subjectEvidence } = input;
  if (
    subjectEvidence.ownerRef !== request.decision.purchasingContext.contextRef ||
    subjectEvidence.ownerRevisionRef !== request.decision.purchasingContext.contextRevision ||
    subjectEvidence.currentness.evaluatedAt !== request.decision.operationTime ||
    subjectEvidence.subjectAuthority.kind !== request.subject.kind ||
    !sameSubject(subjectEvidence.subjectAuthority.subject, request.subject)
  ) {
    return Effect.fail(
      failure(
        'UNVERIFIABLE',
        DISCOUNT_AUDIENCE_OWNER_REF,
        'Discount nonselection requires the exact Current purchase-context subject proof',
      ),
    );
  }

  const pricePaths = commercialTotal.sourceEvidence.preRound.lines.map(
    ({ composition }) => composition.unitPriceCalculation.input.exactPrice.path,
  );
  const pathTags = pricePaths.map(({ _tag }) => _tag);
  let audienceDecision: DiscountNonSelection['audienceDecision'];
  const { subject } = request;
  if (subject.kind === 'GUEST') {
    if (pathTags.some((tag) => tag !== 'NO_GROUP_GUEST')) {
      return Effect.fail(
        failure(
          'UNVERIFIABLE',
          DISCOUNT_AUDIENCE_OWNER_REF,
          'Guest Discount nonselection conflicts with the retained Price audience path',
        ),
      );
    }
    audienceDecision = { kind: 'GUEST' };
  } else {
    if (pathTags.some((tag) => tag !== 'NO_GROUP_NONE')) {
      return Effect.succeed({ kind: 'DISCOUNT_AUDIENCE_SELECTED' });
    }
    const interpretations = pricePaths.flatMap((path) =>
      Match.value(path).pipe(
        Match.tag('NO_GROUP_NONE', (nonePath) => {
          const decodedInput = Schema.decodeUnknownOption(PriceGroupInterpretationInputSchema)({
            assignmentRequest: {
              authorizationSubject: subject.authorizationSubject,
              effectiveAt: nonePath.resolutionInput.ownerResolution.effectiveAt,
              profile: nonePath.resolutionInput.ownerResolution.profile,
            },
            basis: nonePath.resolutionInput.interpretation.basis,
          });
          return Option.isSome(decodedInput)
            ? [{ input: decodedInput.value, interpretation: nonePath.resolutionInput.interpretation }]
            : [];
        }),
        Match.orElse(() => []),
      ),
    );
    if (interpretations.length !== pricePaths.length) {
      return Effect.fail(
        failure(
          'UNVERIFIABLE',
          DISCOUNT_AUDIENCE_OWNER_REF,
          'Profile Discount nonselection lost its exact owner NONE assignment input',
        ),
      );
    }
    audienceDecision = {
      interpretations,
      kind: 'PROFILE_OWNER_NONE',
    };
  }

  return Schema.decodeUnknownEffect(PricingMaterialDiscountSelectionSchema, { onExcessProperty: 'error' })({
    audienceDecision,
    kind: 'DISCOUNT_NOT_SELECTED_NO_ELIGIBLE_AUDIENCE',
    subjectEvidence: discountSubjectEvidenceFor(subjectEvidence),
  }).pipe(
    Effect.flatMap((selection) =>
      selection.kind === 'DISCOUNT_NOT_SELECTED_NO_ELIGIBLE_AUDIENCE'
        ? Effect.succeed({ kind: 'DISCOUNT_NOT_SELECTED' as const, selection })
        : Effect.fail(
            failure(
              'UNVERIFIABLE',
              DISCOUNT_AUDIENCE_OWNER_REF,
              'Discount nonselection decoder returned a selected audience',
            ),
          ),
    ),
    Effect.mapError((cause) =>
      failure(
        'UNVERIFIABLE',
        DISCOUNT_AUDIENCE_OWNER_REF,
        'Discount nonselection did not preserve the exact CCC subject and Price Group NONE evidence',
        cause,
      ),
    ),
  );
};

interface PricingInternalSetAuthority {
  readonly nextApplicabilityBoundary?: string;
  readonly observedAt: PricingExactPriceOwnerReadReceipt['authority']['observedAt'];
  readonly ownerRevision: string;
  readonly ownerRootRef: string;
  readonly predicateRef: string;
  readonly verificationRef: string;
}

interface PricingInternalCurrentFact {
  readonly effectivePeriod: { readonly effectiveFrom: string; readonly effectiveTo: null | string };
  readonly factRef: string;
  readonly factRevisionRef: string;
}

const internalSourceEvidence = (input: {
  readonly attempt: Parameters<
    CurrentPricingDecisionWholeCompositionPort['buildMaterialEvidenceRequest']
  >[0]['attempt'];
  readonly authority: PricingInternalSetAuthority;
  readonly currencyCode: string;
  readonly factProofs: readonly PricingOwnerFactProof[];
  readonly facts: readonly PricingInternalCurrentFact[];
  readonly family: PricingSourceEvidenceFamily;
  readonly request: CurrentPricingDecisionRequest;
}): Effect.Effect<PricingSourceEvidenceResult, CurrentPricingDecisionOwnerReadFailure> => {
  const { attempt, authority, currencyCode, factProofs, facts, family, request } = input;
  if (
    authority.observedAt > attempt.completedAt ||
    (authority.nextApplicabilityBoundary !== undefined && attempt.completedAt >= authority.nextApplicabilityBoundary)
  ) {
    return Effect.fail(
      failure(
        'STALE',
        authority.ownerRootRef,
        `${family} owner receipt is not Current through the completed whole attempt`,
      ),
    );
  }
  const exactProofs =
    facts.length === factProofs.length &&
    facts.every(
      ({ factRef, factRevisionRef }) =>
        factProofs.filter((proof) => proof.factRef === factRef && proof.factRevisionRef === factRevisionRef).length ===
        1,
    ) &&
    factProofs.every(
      ({ factRef, factRevisionRef }) =>
        facts.filter((fact) => fact.factRef === factRef && fact.factRevisionRef === factRevisionRef).length === 1,
    );
  if (!exactProofs) {
    return Effect.fail(
      failure('UNVERIFIABLE', authority.ownerRootRef, `${family} owner receipt does not prove its exact Current facts`),
    );
  }
  const ownerScope = {
    ownerModuleId: 'commerce.pricing',
    ownerRootRef: authority.ownerRootRef,
    predicateRef: authority.predicateRef,
    tenantId: request.decision.tenantId,
  };
  const temporal = {
    effectiveAt: request.decision.operationTime,
    evaluatedAt: request.decision.operationTime,
    evaluationMode: 'HISTORICAL_AS_OF' as const,
    observedAt: authority.observedAt,
    requestedAt: attempt.snapshot.requestedAt,
  };
  if (authority.nextApplicabilityBoundary !== undefined) {
    Object.assign(temporal, { nextMaterialBoundary: authority.nextApplicabilityBoundary });
  }
  const sourceRequest = {
    currencyCode,
    effectiveAt: request.decision.operationTime,
    family,
    ownerScope,
    requestedAt: attempt.snapshot.requestedAt,
  };
  const completenessEvidence = {
    observedAt: authority.observedAt,
    ownerRevision: authority.ownerRevision,
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: authority.predicateRef },
  };
  if (authority.nextApplicabilityBoundary !== undefined) {
    Object.assign(completenessEvidence, { nextApplicabilityBoundary: authority.nextApplicabilityBoundary });
  }
  const sourceCompleteness = {
    completenessEvidence,
    currencyCode,
    family,
    ownerScope,
    ownerSetRevisionRef: authority.ownerRevision,
    temporal,
    verification: {
      kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
      verificationRef: authority.verificationRef,
    },
  };
  const source =
    facts.length === 0
      ? { _tag: 'VERIFIED_ABSENT' as const, completeness: sourceCompleteness, request: sourceRequest }
      : {
          _tag: 'VERIFIED_PRESENT' as const,
          completeness: sourceCompleteness,
          currentFacts: facts.map((fact) => {
            const proof = factProofs.find(
              (candidate) => candidate.factRef === fact.factRef && candidate.factRevisionRef === fact.factRevisionRef,
            );
            return {
              currencyCode,
              effectivePeriod: fact.effectivePeriod,
              factRef: fact.factRef,
              factRevisionRef: fact.factRevisionRef,
              family,
              ownerScope,
              temporal,
              verification: {
                kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
                verificationRef: proof?.verificationRef ?? '',
              },
            };
          }),
          request: sourceRequest,
        };
  return Schema.decodeEffect(PricingSourceEvidenceResultSchema, { onExcessProperty: 'error' })(source).pipe(
    Effect.mapError((cause) =>
      failure('UNVERIFIABLE', authority.ownerRootRef, `${family} owner receipt cannot form source evidence`, cause),
    ),
  );
};

const priceSourceEvidence = (
  lookup: Extract<ExactPriceLookupResult, { readonly _tag: 'ABSENT' | 'FOUND' }>,
  receipt: PricingExactPriceOwnerReadReceipt,
  effectivePeriod: { readonly effectiveFrom: string; readonly effectiveTo: null | string } | undefined,
  attempt: Parameters<CurrentPricingDecisionWholeCompositionPort['buildMaterialEvidenceRequest']>[0]['attempt'],
  request: CurrentPricingDecisionRequest,
) =>
  internalSourceEvidence({
    attempt,
    authority: receipt.authority,
    currencyCode: request.decision.currencyCode,
    factProofs: receipt.factProofs,
    facts:
      isAbsentPriceLookup(lookup) || effectivePeriod === undefined
        ? []
        : [
            {
              effectivePeriod,
              factRef: lookup.priceRef.resourceId,
              factRevisionRef: lookup.priceRevision.revisionId,
            },
          ],
    family: 'PRICE',
    request,
  }).pipe(
    Effect.filterOrFail(
      () => !(isFoundPriceLookup(lookup) && effectivePeriod === undefined),
      () =>
        failure(
          'UNVERIFIABLE',
          receipt.authority.ownerRootRef,
          'Used Price receipt lost the effective scheduled Revision',
        ),
    ),
  );

const discountOwnerReadReceipt = (currentSet: PricingContractualDiscountCurrentSet) => ({
  authority: currentSet.authority,
  completenessEvidence: currentSet.completenessEvidence,
  factProofs: currentSet.factProofs,
  predicate: currentSet.predicate,
});

const discountSourceEvidence = (
  currentSet: PricingContractualDiscountCurrentSet,
  attempt: Parameters<CurrentPricingDecisionWholeCompositionPort['buildMaterialEvidenceRequest']>[0]['attempt'],
  request: CurrentPricingDecisionRequest,
) => {
  const authority = { ...currentSet.authority };
  if (currentSet.completenessEvidence.nextApplicabilityBoundary !== undefined) {
    Object.assign(authority, {
      nextApplicabilityBoundary: currentSet.completenessEvidence.nextApplicabilityBoundary,
    });
  }
  return internalSourceEvidence({
    attempt,
    authority,
    currencyCode: request.decision.currencyCode,
    factProofs: currentSet.factProofs,
    facts: currentSet.currentDiscounts.map(({ definition, effectivePeriod }) => ({
      effectivePeriod,
      factRef: definition.discountId,
      factRevisionRef: definition.revision.revisionId,
    })),
    family: 'DISCOUNT',
    request,
  });
};

type PricingSetBackedMaterialEvidenceFenceSource = Extract<
  PricingMaterialEvidenceFenceSource,
  { readonly sourceEvidence: PricingSourceEvidenceResult }
>;

const fenceSource = (
  sourceEvidence: PricingSourceEvidenceResult,
  verificationMaterial: PricingSetBackedMaterialEvidenceFenceSource['verificationMaterial'],
): PricingSetBackedMaterialEvidenceFenceSource | undefined =>
  Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(sourceEvidence) ||
  Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(sourceEvidence)
    ? { sourceEvidence, verificationMaterial }
    : undefined;

const requireFence = (
  source: PricingMaterialEvidenceFenceSource | undefined,
  ownerRef: string,
  reason: string,
): Effect.Effect<PricingMaterialEvidenceFenceSource, CurrentPricingDecisionOwnerReadFailure> =>
  Effect.fromOption(Option.fromUndefinedOr(source)).pipe(
    Effect.mapError((cause) => failure('UNVERIFIABLE', ownerRef, reason, cause)),
  );

export const makeCurrentPricingDecisionWholeComposition = (): CurrentPricingDecisionWholeCompositionPort => ({
  buildAllocationInput: ({ discountComposition, feeResults, request }) =>
    Effect.succeed({
      discountComposition,
      feeResults: feeResults.filter((result) => result.outcome === 'COMMERCIAL_FEES_APPLIED'),
      precision: {
        allocationScale: PRICING_ALLOCATION_PROFILE.maximumScale,
        amountPrecision: PRICING_ALLOCATION_PROFILE.maximumPrecision,
        contractVersion: PRICING_ALLOCATION_CONTRACT_VERSION,
        remainderRule: PRICING_ALLOCATION_PROFILE.remainderRule,
      },
      recipientClassifications: request.decision.lines.map(({ occurrenceId }) => ({
        occurrenceId,
        recipientKind: 'MERCHANDISE' as const,
      })),
    }),
  buildDiscountCompositionRequest: ({ applicability, feeResults, request, unitPrices }) => {
    const currencySupport = unitPrices[0]?.input.exactPrice.currencySupport;
    if (currencySupport === undefined) {
      return Effect.fail(
        failure(
          'CONFIGURATION',
          'pricing-current-decision:whole-composition',
          'Discount composition has no stable line',
        ),
      );
    }
    if (
      applicability.some(({ outcome }) => outcome === 'DISCOUNT_CONFLICT' || outcome === 'DISCOUNT_INVARIANT_VIOLATION')
    ) {
      return Effect.fail(failure('CONFLICT', DISCOUNT_OWNER_REF, 'Contractual Discount Current set is conflicting'));
    }
    const candidates = applicability.map((result) => discountCandidate(result, request, unitPrices));
    if (
      candidates.some(
        (candidate, index) => candidate === null && applicability[index]?.outcome === 'DISCOUNT_APPLICABLE',
      )
    ) {
      return Effect.fail(
        failure(
          'UNVERIFIABLE',
          DISCOUNT_OWNER_REF,
          'Applicable Contractual Discount lost its exact stable line or whole-purchase basis',
        ),
      );
    }
    const readyCandidates = candidates.filter(
      (candidate): candidate is Exclude<typeof candidate, null> => candidate !== null,
    );
    const wholePurchaseCandidate = readyCandidates.find(
      (candidate): candidate is Extract<(typeof readyCandidates)[number], { readonly kind: 'WHOLE_PURCHASE' }> =>
        candidate.kind === 'WHOLE_PURCHASE',
    );
    const wholePurchaseBasis = wholePurchaseCandidate?.applicability.basis;
    const compositionRequest = {
      candidates: readyCandidates,
      currencySupport,
      decision: request.decision,
      lineBases: feeResults.flatMap((result) =>
        result.outcome === 'COMMERCIAL_FEES_APPLIED'
          ? [
              {
                amount: result.discountableLineBasis,
                applicablePricingFeeTotal: result.contributionTotal,
                baseLineValue: result.input.baseLineValue,
                occurrenceId: result.input.occurrenceId,
              },
            ]
          : [],
      ),
    };
    if (wholePurchaseBasis !== undefined) {
      Object.assign(compositionRequest, { wholePurchaseBasis });
    }
    return Effect.succeed(compositionRequest);
  },
  buildLineCompositionRequest: ({
    allocation,
    attempt,
    discountComposition,
    feeResults,
    promotionSelection,
    request,
    unitPrices,
  }) => {
    const wholePurchaseAllocation = allocation.allocationResults.find(
      (result) => result.outcome === 'ALLOCATION_APPLIED' || result.outcome === 'ALLOCATION_NOT_APPLICABLE',
    );
    const compositionRequest = {
      candidateRef: attempt.candidateRef,
      decision: request.decision,
      discountComposition,
      feeResults,
      promotionComposition: promotionSelection,
      unitPrices,
    };
    if (wholePurchaseAllocation !== undefined) {
      Object.assign(compositionRequest, { wholePurchaseAllocation });
    }
    return Schema.decodeEffect(PricingLineCompositionRequestSchema, { onExcessProperty: 'error' })(
      compositionRequest,
    ).pipe(
      Effect.mapError((cause) =>
        failure(
          'UNVERIFIABLE',
          'pricing-current-decision:line-composition',
          'Line composition did not preserve the canonical Pricing inputs',
          cause,
        ),
      ),
    );
  },
  buildMaterialEvidenceRequest: Effect.fn('CurrentPricingDecisionComposition.buildMaterialEvidenceRequest')(
    function* buildMaterialEvidenceRequestProgram({
      attempt,
      commercialTotal,
      discountApplicabilityInputs,
      discountCurrentSets,
      externalOwnerEvidence,
      feeSetReads,
      priceCandidateSetReceipts,
      purchaseContextEvidence,
      request,
      tierSetReads,
      zeroFloorSetReads,
    }) {
      const discountSelection = yield* buildCurrentPricingDiscountNonSelection({
        commercialTotal,
        request,
        subjectEvidence: purchaseContextEvidence,
      });
      if ([discountSelection.kind === 'DISCOUNT_NOT_SELECTED', discountCurrentSets.length > 0].every(Boolean)) {
        return yield* failure(
          'CONFLICT',
          DISCOUNT_OWNER_REF,
          'Discount nonselection cannot retain selected owner Current sets',
        );
      }
      const totalLines = commercialTotal.sourceEvidence.preRound.lines;
      const discountSetCountIsValid =
        discountCurrentSets.length >= totalLines.length && discountCurrentSets.length <= totalLines.length + 1;
      if ([discountSelection.kind === 'DISCOUNT_AUDIENCE_SELECTED', !discountSetCountIsValid].every(Boolean)) {
        return yield* failure(
          'UNVERIFIABLE',
          DISCOUNT_OWNER_REF,
          'Selected Discount audience did not retain the exact ordered owner Current sets',
        );
      }
      if (
        !allEqualTo(totalLines.length, [
          request.decision.lines.length,
          feeSetReads.length,
          tierSetReads.length,
          priceCandidateSetReceipts.length,
          zeroFloorSetReads.length,
        ])
      ) {
        return yield* failure(
          'UNVERIFIABLE',
          MATERIAL_EVIDENCE_OWNER_REF,
          'Pricing owner receipts do not preserve the exact ordered commercial-result lines',
        );
      }
      const firstSupport = totalLines[0]?.composition.unitPriceCalculation.input.exactPrice.currencySupport;
      if (firstSupport === undefined) {
        return yield* failure(
          'UNVERIFIABLE',
          CURRENCY_SUPPORT_OWNER_REF,
          'Material evidence has no retained Currency Support receipt',
        );
      }
      const currencySupport = Option.getOrUndefined(supportEvidence(firstSupport, request.decision.currencyCode));
      if (currencySupport === undefined) {
        return yield* failure(
          'UNVERIFIABLE',
          CURRENCY_SUPPORT_OWNER_REF,
          'Currency Support proof does not bind the whole-attempt request interval',
        );
      }
      if (
        [
          currencySupport.request.requestedAt !== attempt.snapshot.requestedAt,
          currencySupport.request.effectiveAt !== request.decision.operationTime,
        ].some(Boolean)
      ) {
        return yield* failure(
          'UNVERIFIABLE',
          CURRENCY_SUPPORT_OWNER_REF,
          'Currency Support proof does not bind the whole-attempt request interval',
        );
      }
      const sources: PricingMaterialEvidenceFenceSource[] = [...externalOwnerEvidence.fenceSources];
      const currencyFence = fenceSource(currencySupport, {
        kind: 'PRICING_CURRENCY_SUPPORT_AUTHORITY',
        support: firstSupport,
      });
      if (currencyFence === undefined) {
        return yield* failure(
          'UNVERIFIABLE',
          CURRENCY_SUPPORT_OWNER_REF,
          'Currency Support evidence is not owner-verified',
        );
      }
      sources.push(currencyFence);

      const buildLineEvidence = Effect.fn('CurrentPricingDecisionComposition.buildLineEvidence')(
        function* buildLineEvidenceProgram(totalLine: (typeof totalLines)[number], index: number) {
          const orderedReceipts = yield* Effect.all(
            {
              decisionLine: Effect.fromOption(Option.fromUndefinedOr(request.decision.lines[index])),
              feeRead: Effect.fromOption(Option.fromUndefinedOr(feeSetReads[index])),
              receipts: Effect.fromOption(Option.fromUndefinedOr(priceCandidateSetReceipts[index])),
              tierRead: Effect.fromOption(Option.fromUndefinedOr(tierSetReads[index])),
              zeroFloorSetRead: Effect.fromOption(Option.fromUndefinedOr(zeroFloorSetReads[index])),
            },
            { concurrency: 5 },
          ).pipe(
            Effect.mapError((cause) =>
              failure(
                'UNVERIFIABLE',
                MATERIAL_EVIDENCE_OWNER_REF,
                'A Pricing line lost its exact Price, Tier, or Fee owner receipt',
                cause,
              ),
            ),
          );
          const { decisionLine, feeRead, receipts, tierRead, zeroFloorSetRead } = orderedReceipts;
          if (
            !allEqualTo(totalLine.occurrenceId, [decisionLine.occurrenceId, zeroFloorSetRead.occurrenceId]) ||
            tierRead.request.outcome !== 'TIER_SET_CURRENT'
          ) {
            return yield* failure(
              'UNVERIFIABLE',
              MATERIAL_EVIDENCE_OWNER_REF,
              'A Pricing line lost its exact Price, Tier, or Fee owner receipt',
            );
          }
          const { exactPrice } = totalLine.composition.unitPriceCalculation.input;
          if (!('usedPrice' in exactPrice.path)) {
            return yield* failure(
              'UNVERIFIABLE',
              EXACT_PRICE_OWNER_REF,
              'Resolved commercial line does not retain an exact used Price',
            );
          }
          const lookups = priceLookups(exactPrice).filter(isMaterialPriceLookup);
          if (!exactPriceLineHasCompleteReceipts({ exactPrice, priceCandidateSetAuthorities: receipts })) {
            return yield* failure(
              'UNVERIFIABLE',
              EXACT_PRICE_OWNER_REF,
              'Resolved Price path does not preserve its ordered owner receipts',
            );
          }
          const { usedPrice } = exactPrice.path;
          const usedIndex = lookups.findIndex((lookup) => {
            if (!isFoundPriceLookup(lookup)) {
              return false;
            }
            return (
              allEqualTo(lookup.priceRef.resourceId, [usedPrice.priceRef.resourceId]) &&
              allEqualTo(lookup.priceRevision.revisionId, [usedPrice.priceRevision.revisionId])
            );
          });
          const usedEvidence = yield* Effect.all(
            {
              lookup: Effect.fromOption(Option.fromUndefinedOr(lookups[usedIndex])),
              receipt: Effect.fromOption(Option.fromUndefinedOr(receipts[usedIndex])),
            },
            { concurrency: 2 },
          ).pipe(
            Effect.mapError((cause) =>
              failure(
                'UNVERIFIABLE',
                EXACT_PRICE_OWNER_REF,
                'Used Price cannot be matched to its transaction-scoped receipt',
                cause,
              ),
            ),
          );
          if (!isFoundPriceLookup(usedEvidence.lookup)) {
            return yield* failure(
              'UNVERIFIABLE',
              EXACT_PRICE_OWNER_REF,
              'Used Price cannot be matched to its transaction-scoped receipt',
            );
          }
          const { lookup: usedLookup, receipt: usedReceipt } = usedEvidence;
          const usedPriceSource = yield* priceSourceEvidence(
            usedLookup,
            usedReceipt,
            tierRead.request.input.attempt.exactPrice.price.effectivePeriod,
            attempt,
            request,
          );
          const usedFence = yield* requireFence(
            fenceSource(usedPriceSource, {
              kind: 'PRICING_PRICE_AUTHORITY',
              lookupRequest: usedLookup.request,
              ownerReadReceipt: usedReceipt,
            }),
            usedReceipt.authority.ownerRootRef,
            'Used Price proof is not verified',
          );
          sources.push(usedFence);
          let assignedGroupAbsence: PricingSourceEvidenceResult | undefined;
          if ('groupAbsence' in exactPrice.path) {
            const { groupAbsence } = exactPrice.path;
            const absenceIndex = lookups.findIndex((lookup) => sameLookup(lookup, groupAbsence));
            const absenceEvidence = yield* Effect.all(
              {
                lookup: Effect.fromOption(Option.fromUndefinedOr(lookups[absenceIndex])),
                receipt: Effect.fromOption(Option.fromUndefinedOr(receipts[absenceIndex])),
              },
              { concurrency: 2 },
            ).pipe(
              Effect.mapError((cause) =>
                failure(
                  'UNVERIFIABLE',
                  EXACT_PRICE_OWNER_REF,
                  'Assigned-group fallback lost its authoritative absence receipt',
                  cause,
                ),
              ),
            );
            if (!isAbsentPriceLookup(absenceEvidence.lookup)) {
              return yield* failure(
                'UNVERIFIABLE',
                EXACT_PRICE_OWNER_REF,
                'Assigned-group fallback lost its authoritative absence receipt',
              );
            }
            const { lookup: absenceLookup, receipt: absenceReceipt } = absenceEvidence;
            assignedGroupAbsence = yield* priceSourceEvidence(
              absenceLookup,
              absenceReceipt,
              undefined,
              attempt,
              request,
            );
            const absenceFence = yield* requireFence(
              fenceSource(assignedGroupAbsence, {
                kind: 'PRICING_PRICE_AUTHORITY',
                lookupRequest: absenceLookup.request,
                ownerReadReceipt: absenceReceipt,
              }),
              absenceReceipt.authority.ownerRootRef,
              'Assigned-group absence is not owner-verified',
            );
            sources.push(absenceFence);
          }

          const { tierSet } = tierRead.request.input;
          const tiersByRevision = new Map(
            tierSet.currentTiers.map((tier) => [tier.definition.revision.revisionId, tier] as const),
          );
          const tierFacts = tierSet.factProofs.map((proof) => {
            const tier = tiersByRevision.get(proof.factRevisionRef);
            return tier === undefined
              ? undefined
              : {
                  effectivePeriod: tier.effectivePeriod,
                  factRef: proof.factRef,
                  factRevisionRef: proof.factRevisionRef,
                };
          });
          if (tierFacts.some((fact) => fact === undefined)) {
            return yield* failure(
              'UNVERIFIABLE',
              tierRead.authority.ownerRootRef,
              'Quantity Tier receipt lost a Current Tier effective period',
            );
          }
          const quantityTiers = yield* internalSourceEvidence({
            attempt,
            authority: tierRead.authority,
            currencyCode: request.decision.currencyCode,
            factProofs: tierSet.factProofs,
            facts: tierFacts.filter((fact): fact is Exclude<typeof fact, undefined> => fact !== undefined),
            family: 'QUANTITY_TIER',
            request,
          });
          const tierReceipt = { authority: tierRead.authority, factProofs: tierSet.factProofs };
          const tierFence = yield* requireFence(
            fenceSource(quantityTiers, {
              kind: 'PRICING_QUANTITY_TIER_AUTHORITY',
              ownerReadReceipt: tierReceipt,
              selectionInput: tierRead.request.input,
            }),
            tierRead.authority.ownerRootRef,
            'Quantity Tier proof is not owner-verified',
          );
          sources.push(tierFence);

          const feeFacts = feeRead.input.feeSet.fees.map(({ definition, effectivePeriod }) => ({
            effectivePeriod,
            factRef: definition.feeRef.resourceId,
            factRevisionRef: definition.revision.revisionId,
          }));
          const commercialFees = yield* internalSourceEvidence({
            attempt,
            authority: feeRead.authority,
            currencyCode: request.decision.currencyCode,
            factProofs: feeRead.factProofs,
            facts: feeFacts,
            family: 'COMMERCIAL_FEE',
            request,
          });
          const feeFence = yield* requireFence(
            fenceSource(commercialFees, {
              currentSet: feeRead.input.feeSet,
              kind: 'PRICING_COMMERCIAL_FEE_AUTHORITY',
              ownerReadReceipt: { authority: feeRead.authority, factProofs: feeRead.factProofs },
            }),
            feeRead.authority.ownerRootRef,
            'Commercial Fee proof is not owner-verified',
          );
          sources.push(feeFence);

          let lineDiscounts: PricingMaterialDiscountSelection;
          if (discountSelection.kind === 'DISCOUNT_NOT_SELECTED') {
            lineDiscounts = discountSelection.selection;
          } else {
            const currentSet = discountCurrentSets[index];
            const expectedBasis = discountBasisFor(totalLine.composition.unitPriceCalculation);
            if (
              currentSet === undefined ||
              expectedBasis === undefined ||
              currentSet.predicate.basis.kind !== 'VARIANT_LINE' ||
              !sameDiscountBasis(currentSet.predicate.basis, expectedBasis)
            ) {
              return yield* failure(
                'UNVERIFIABLE',
                DISCOUNT_OWNER_REF,
                'Line Discount material lost its exact ordered owner Current-set receipt',
              );
            }
            const sourceEvidence = yield* discountSourceEvidence(currentSet, attempt, request);
            const discountFence = fenceSource(sourceEvidence, {
              applicabilityBindings: totalLine.composition.lineDiscountContributions.map(
                ({ candidate }) => candidate.audienceBinding,
              ),
              identityKeys: currentSet.currentDiscounts.map(({ definition }) => definition.identityKey),
              kind: 'PRICING_DISCOUNT_AUTHORITY',
              ownerReadReceipt: discountOwnerReadReceipt(currentSet),
            });
            if (discountFence === undefined) {
              return yield* failure(
                'UNVERIFIABLE',
                currentSet.authority.ownerRootRef,
                'Line Discount Current-set proof is not owner-verified',
              );
            }
            sources.push(discountFence);
            lineDiscounts = { kind: 'DISCOUNT_SELECTED', sourceEvidence };
          }

          let zeroFloor: PricingSourceEvidenceResult | undefined;
          if (totalLine.floorEvaluation.kind === 'AUTHORIZED_ZERO_FLOOR') {
            if ('failure' in zeroFloorSetRead.authorizationSet) {
              return yield* failure(
                'UNVERIFIABLE',
                zeroFloorSetRead.authority.ownerRootRef,
                'Applied ZERO_FLOOR lacks a verified Current authorization set',
              );
            }
            const floorFacts = zeroFloorSetRead.authorizationSet.authorizations.map((authorization) => ({
              effectivePeriod: {
                effectiveFrom: authorization.effectivePeriod.startsAt,
                effectiveTo: authorization.effectivePeriod.endsAt ?? null,
              },
              factRef: authorization.authorizationRef,
              factRevisionRef: authorization.authorizationRevision,
            }));
            zeroFloor = yield* internalSourceEvidence({
              attempt,
              authority: zeroFloorSetRead.authority,
              currencyCode: request.decision.currencyCode,
              factProofs: zeroFloorSetRead.factProofs,
              facts: floorFacts,
              family: 'ZERO_FLOOR',
              request,
            });
            const floorFence = fenceSource(zeroFloor, {
              appliedGuard: {
                authorization: {
                  commercialScope: totalLine.floorEvaluation.authorization.businessScope.commercialScope,
                  completenessEvidence: zeroFloorSetRead.authorizationSet.completenessEvidence,
                  economicEnvelope: {
                    currencyCode: totalLine.floorEvaluation.authorization.currencyCode,
                    maximumRawAmount: '0',
                    minimumRawAmount: totalLine.floorEvaluation.authorization.economicCoverage.minimumRawAmount,
                  },
                  effectivePeriod: totalLine.floorEvaluation.authorization.effectivePeriod,
                  pricingBasis: totalLine.floorEvaluation.authorization.businessScope.pricingBasis,
                  selection: totalLine.floorEvaluation.authorization.businessScope.catalogSelection,
                  zeroFloorRef: totalLine.floorEvaluation.authorization.authorizationRef,
                  zeroFloorRevision: totalLine.floorEvaluation.authorization.authorizationRevision,
                },
                floorDelta: totalLine.floorEvaluation.floorAdjustment,
                kind: 'AUTHORIZED_ZERO_FLOOR',
                rawPreTaxAmount: totalLine.floorEvaluation.rawPostCompositionValue,
              },
              kind: 'PRICING_ZERO_FLOOR_AUTHORITY',
              occurrenceId: totalLine.occurrenceId,
              ownerReadReceipt: {
                authority: zeroFloorSetRead.authority,
                factProofs: zeroFloorSetRead.factProofs,
              },
              query: zeroFloorSetRead.authorizationSet.query,
            });
            if (floorFence === undefined) {
              return yield* failure(
                'UNVERIFIABLE',
                zeroFloorSetRead.authority.ownerRootRef,
                'ZERO_FLOOR proof is not owner-verified',
              );
            }
            sources.push(floorFence);
          }
          const pricePath = { usedPrice: usedPriceSource };
          if (assignedGroupAbsence !== undefined) {
            Object.assign(pricePath, { assignedGroupAbsence });
          }
          const lineEvidence = {
            commercialFees,
            lineDiscounts,
            occurrenceId: totalLine.occurrenceId,
            pricePath,
            quantityTiers,
          };
          if (zeroFloor !== undefined) {
            Object.assign(lineEvidence, { zeroFloor });
          }
          return lineEvidence;
        },
      );
      const lines = yield* Effect.forEach(totalLines, buildLineEvidence, { concurrency: 16 });
      const allocationAssessment =
        commercialTotal.sourceEvidence.preRound.rawComposition.wholePurchaseAllocationEvidence;
      let wholePurchase: PricingMaterialEvidenceAssemblyRequest['wholePurchase'];
      if (discountSelection.kind === 'DISCOUNT_NOT_SELECTED') {
        if (allocationAssessment !== undefined) {
          return yield* failure(
            'CONFLICT',
            DISCOUNT_OWNER_REF,
            'Discount nonselection cannot accompany retained whole-purchase Discount material',
          );
        }
        wholePurchase = { contractualDiscounts: discountSelection.selection };
      } else {
        const currentSet = discountCurrentSets[totalLines.length];
        if (currentSet === undefined) {
          if (allocationAssessment !== undefined) {
            return yield* failure(
              'UNVERIFIABLE',
              DISCOUNT_OWNER_REF,
              'Whole-purchase Discount allocation lacks its exact owner Current-set receipt',
            );
          }
          const subjectEvidence = yield* Schema.decodeUnknownEffect(PricingDiscountSubjectEvidenceSchema, {
            onExcessProperty: 'error',
          })(discountSubjectEvidenceFor(purchaseContextEvidence)).pipe(
            Effect.mapError((cause) =>
              failure(
                'UNVERIFIABLE',
                DISCOUNT_AUDIENCE_OWNER_REF,
                'Price Group scope ineligibility lost the exact CCC subject proof',
                cause,
              ),
            ),
          );
          wholePurchase = {
            contractualDiscounts: {
              audienceKind: 'PRICE_GROUP',
              kind: 'DISCOUNT_NOT_SELECTED_SCOPE_INELIGIBLE',
              reason: 'PRICE_GROUP_LINE_SCOPE_ONLY',
              scope: 'WHOLE_PURCHASE',
              subjectEvidence,
            },
          };
        } else if (currentSet.predicate.basis.kind === 'WHOLE_PURCHASE') {
          const sourceEvidence = yield* discountSourceEvidence(currentSet, attempt, request);
          const selectedIdentity =
            allocationAssessment === undefined
              ? undefined
              : currentSet.currentDiscounts.find(
                  ({ definition }) =>
                    definition.discountId === allocationAssessment.request.source.logicalFactRef &&
                    definition.revision.revisionId === allocationAssessment.request.source.revisionRef,
                )?.definition.identityKey;
          const applicabilityBindings = discountApplicabilityInputs.flatMap(({ audienceBinding }) =>
            selectedIdentity !== undefined && sameDiscountIdentity(audienceBinding.identityKey, selectedIdentity)
              ? [audienceBinding]
              : [],
          );
          if ([allocationAssessment !== undefined, applicabilityBindings.length !== 1].every(Boolean)) {
            return yield* failure(
              'UNVERIFIABLE',
              currentSet.authority.ownerRootRef,
              'Whole-purchase Discount allocation lost its exact applicability binding',
            );
          }
          const discountFence = fenceSource(sourceEvidence, {
            applicabilityBindings,
            identityKeys: currentSet.currentDiscounts.map(({ definition }) => definition.identityKey),
            kind: 'PRICING_DISCOUNT_AUTHORITY',
            ownerReadReceipt: discountOwnerReadReceipt(currentSet),
          });
          if (discountFence === undefined) {
            return yield* failure(
              'UNVERIFIABLE',
              currentSet.authority.ownerRootRef,
              'Whole-purchase Discount Current-set proof is not owner-verified',
            );
          }
          sources.push(discountFence);
          const selectedWholePurchase: PricingMaterialEvidenceAssemblyRequest['wholePurchase'] = {
            contractualDiscounts: { kind: 'DISCOUNT_SELECTED', sourceEvidence },
          };
          if (allocationAssessment !== undefined) {
            Object.assign(selectedWholePurchase, { allocationAssessment });
          }
          wholePurchase = selectedWholePurchase;
        } else {
          return yield* failure(
            'UNVERIFIABLE',
            DISCOUNT_OWNER_REF,
            'Whole-purchase Discount material lost its exact owner Current-set receipt',
          );
        }
      }
      const materialRequest = {
        commercialTotal,
        currencySupport,
        externalOwnerEvidence: externalOwnerEvidence.retained,
        lines,
        ownerFenceRequest: {
          candidateRef: commercialTotal.candidateRef,
          decision: request.decision,
          effectiveAt: request.decision.operationTime,
          evaluatedAt: attempt.completedAt,
          requestedAt: attempt.snapshot.requestedAt,
          sources,
          subject: request.subject,
        },
        requestedAt: attempt.snapshot.requestedAt,
        revalidatedAt: attempt.completedAt,
        wholePurchase,
      };
      return yield* Schema.decodeEffect(PricingMaterialEvidenceAssemblyRequestSchema, {
        onExcessProperty: 'error',
      })(materialRequest).pipe(
        Effect.mapError((cause) =>
          failure(
            'UNVERIFIABLE',
            MATERIAL_EVIDENCE_OWNER_REF,
            'Whole-attempt material evidence does not preserve exact owner bindings',
            cause,
          ),
        ),
      );
    },
  ),
  buildNoApplicablePrice: ({ attempt, exactPriceLines, request }) => {
    if (!exactPriceLines.every(exactPriceLineHasCompleteReceipts)) {
      return Effect.fail(
        failure(
          'UNVERIFIABLE',
          NO_PRICE_OWNER_REF,
          'Terminal Price path lacks a matching transaction-scoped candidate-set receipt',
        ),
      );
    }
    const exactPrices = exactPriceLines.map(({ exactPrice }) => exactPrice);
    const support = exactPrices[0]?.currencySupport;
    if (support === undefined) {
      return Effect.fail(failure('UNVERIFIABLE', NO_PRICE_OWNER_REF, 'No exact Price owner evidence was returned'));
    }
    const bindings: PricingMaterialCurrentBinding[] = [
      ...request.decision.lines.flatMap((line) => [
        {
          completenessEvidence: line.catalog.completeness,
          exactPredicateRef: line.catalog.completeness.scope.predicateRef,
          identityRef: line.occurrenceId,
          kind: 'CATALOG_HANDOFF' as const,
          revisionRef: line.catalog.ownerRevision,
        },
        {
          completenessEvidence: line.catalog.completeness,
          exactPredicateRef: line.catalog.completeness.scope.predicateRef,
          identityRef: line.occurrenceId,
          kind: 'CATALOG_HIERARCHY' as const,
          revisionRef: line.catalog.hierarchyRevision,
        },
      ]),
      {
        completenessEvidence: support.completenessEvidence,
        exactPredicateRef: support.completenessEvidence.scope.predicateRef,
        identityRef: request.decision.tenantId,
        kind: 'CURRENCY_SUPPORT' as const,
        revisionRef: support.supportRevisionRef.resourceId,
      },
    ];
    const lookups: (PricingNoApplicablePrice['lookups'][number] | null)[] = exactPrices.map((resolution, index) => {
      const occurrenceId = request.decision.lines[index]?.occurrenceId;
      if (occurrenceId === undefined) {
        return null;
      }
      if (Schema.is(ExactPriceFoundResolutionSchema)(resolution)) {
        if (!('usedPrice' in resolution.path)) {
          return null;
        }
        const found = resolution.path.usedPrice;
        const evidence = completeness(found, found.request.exactKey);
        bindings.push({
          completenessEvidence: evidence,
          exactPredicateRef: evidence.scope.predicateRef,
          identityRef: found.priceRef.resourceId,
          kind: 'PRICE' as const,
          revisionRef: found.priceRevision.revisionId,
        });
        const resolved = {
          completenessEvidence: evidence,
          exactKey: legacyKey(found.request.exactKey),
          priceRef: found.priceRef.resourceId,
          priceRevision: found.priceRevision.revisionId,
        };
        if ('groupAbsence' in resolution.path) {
          const absentGroup = resolution.path.groupAbsence;
          const groupEvidence = completeness(absentGroup, absentGroup.request.exactKey);
          bindings.push({
            completenessEvidence: groupEvidence,
            exactPredicateRef: groupEvidence.scope.predicateRef,
            identityRef: groupEvidence.scope.predicateRef,
            kind: 'ABSENCE',
            revisionRef: groupEvidence.ownerRevision,
          });
          return {
            lookup: {
              assignedGroupAttempt: {
                absenceEvidence: groupEvidence,
                exactKey: legacyKey(absentGroup.request.exactKey),
              },
              kind: 'ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_RESOLVED',
              noGroupResolution: resolved,
            },
            occurrenceId,
            status: 'RESOLVED',
          };
        }
        return {
          lookup: {
            ...resolved,
            kind:
              found.request.exactKey.priceGroupSelector.kind === 'NO_GROUP'
                ? ('NO_GROUP_RESOLVED' as const)
                : ('ASSIGNED_GROUP_RESOLVED' as const),
          },
          occurrenceId,
          status: 'RESOLVED' as const,
        };
      }
      if (!Schema.is(ExactPriceAbsentResolutionSchema)(resolution)) {
        return null;
      }
      if (!('noGroupAbsence' in resolution.path)) {
        return null;
      }
      const absent = resolution.path.noGroupAbsence;
      const evidence = completeness(absent, absent.request.exactKey);
      bindings.push({
        completenessEvidence: evidence,
        exactPredicateRef: evidence.scope.predicateRef,
        identityRef: evidence.scope.predicateRef,
        kind: 'ABSENCE' as const,
        revisionRef: evidence.ownerRevision,
      });
      const noGroupAttempt = { absenceEvidence: evidence, exactKey: legacyKey(absent.request.exactKey) };
      if (resolution.path.groupAbsence === undefined) {
        return { lookup: { ...noGroupAttempt, kind: 'NO_GROUP_ABSENT' }, occurrenceId, status: 'ABSENT' };
      }
      const { groupAbsence } = resolution.path;
      const groupEvidence = completeness(groupAbsence, groupAbsence.request.exactKey);
      bindings.push({
        completenessEvidence: groupEvidence,
        exactPredicateRef: groupEvidence.scope.predicateRef,
        identityRef: groupEvidence.scope.predicateRef,
        kind: 'ABSENCE',
        revisionRef: groupEvidence.ownerRevision,
      });
      return {
        lookup: {
          assignedGroupAttempt: {
            absenceEvidence: groupEvidence,
            exactKey: legacyKey(groupAbsence.request.exactKey),
          },
          kind: 'ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_ABSENT',
          noGroupAttempt,
        },
        occurrenceId,
        status: 'ABSENT',
      };
    });
    if (lookups.some((lookup) => lookup === null)) {
      return Effect.fail(
        failure('UNVERIFIABLE', NO_PRICE_OWNER_REF, 'Terminal path is not owner-proven exact absence'),
      );
    }
    return Effect.succeed({
      decision: request.decision,
      lookups: lookups.filter((lookup): lookup is Exclude<typeof lookup, null> => lookup !== null),
      outcome: 'NO_APPLICABLE_PRICE' as const,
      proof: {
        currencySupport: support,
        currentness: { materialBindings: bindings, status: 'CURRENT' as const, verifiedAt: attempt.completedAt },
        effectiveAt: request.decision.operationTime,
        observedAt: attempt.completedAt,
      },
    });
  },
  buildPublicationInput: ({ externalOwnerEvidence, materialEvidence }) =>
    Schema.toEquivalence(PricingRetainedExternalOwnerEvidenceSchema)(
      externalOwnerEvidence.retained,
      materialEvidence.externalOwnerEvidence,
    )
      ? Effect.succeed(externalOwnerEvidence.publication)
      : Effect.fail(
          failure(
            'UNVERIFIABLE',
            'pricing-current-decision:publication',
            'Publication owner evidence differs from the retained whole-attempt snapshot',
          ),
        ),
  resolvePromotionRequirement: () => Effect.succeed({ kind: 'PROMOTION_NOT_SELECTED' as const }),
});

const promotionEvaluation = makePricingPromotionCurrentEvaluationService(
  makePricingPromotionCompositionService(unavailablePromotionContributionSource).compose,
  {
    revalidate: () =>
      Effect.fail(
        new PricingPromotionUnavailable({
          reason: 'Promotion has no installed Current owner-evidence revalidation authority',
          retryable: true,
        }),
      ),
  },
);

const scopedAdapters = (transaction: ScopedTransaction, scope: OperationalScope, compositionRevision: string) => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Current Pricing Decision requires a trusted Legal Entity scope',
      }),
    );
  }
  const environment = {
    compositionRevision,
    legalEntityId: scope.legalEntityId,
    requestCorrelation: scope.correlationId,
    tenantId: scope.tenantId,
  };
  return Effect.all(
    {
      catalogEquivalence: catalogPricingPurposeEquivalencePortFromEnvironment(environment),
      catalogQuantity: catalogQuantityBasisCompatibilityPortFromEnvironment(environment),
      commercePriceGroup: commercePriceGroupResolutionPortFromEnvironment(environment),
      currency: currencySupportPersistenceForScope(transaction, scope, compositionRevision),
      discount: contractualDiscountPersistenceForScope(transaction, scope),
      exactPrice: exactPriceResolutionServiceForScope(transaction, scope, compositionRevision),
      externalOwnerEvidence: currentPricingDecisionExternalOwnerEvidencePortFromEnvironment(environment),
      fee: commercialFeePersistenceForScope(transaction, scope),
      floor: zeroFloorAuthorizationPersistenceForScope(transaction, scope),
      price: pricePersistenceForScope(transaction, scope),
      priceGroupCompatibility: priceGroupCompatibilityPortFromEnvironment({
        compositionRevision,
        requestCorrelation: scope.correlationId,
        tenantId: scope.tenantId,
      }),
      tier: quantityTierPersistenceForScope(transaction, scope),
    },
    { concurrency: 12 },
  ).pipe(
    Effect.map(
      ({
        catalogEquivalence,
        catalogQuantity,
        commercePriceGroup,
        currency,
        discount,
        exactPrice,
        externalOwnerEvidence,
        fee,
        floor,
        price,
        priceGroupCompatibility,
        tier,
      }) => {
        const interpreter = makePriceGroupInterpretationService({
          commerce: commercePriceGroup,
          compatibility: priceGroupCompatibility,
        });
        return {
          attemptSource: makeCurrentPricingDecisionAttemptSource({
            catalogQuantity,
            exactPrice,
            interpreter,
            loadCurrencySupport: currency.loadCurrent,
            priceCandidateSets: price,
          }),
          composition: makeCurrentPricingDecisionWholeComposition(),
          discountReader: makeDiscountReader(discount),
          exactPrice,
          externalOwnerEvidence,
          feeReader: makeFeeReader(fee),
          floorReader: makeCurrentPricingDecisionZeroFloorSetReader(floor),
          promotion: promotionEvaluation,
          tierReader: tierReaderFor(tier, price, catalogEquivalence),
        };
      },
    ),
  );
};

export const currentPricingDecisionWholeEvaluationAdaptersForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  compositionRevision: string,
) =>
  scopedAdapters(transaction, scope, compositionRevision).pipe(
    Effect.map((adapters) =>
      Layer.mergeAll(
        Layer.succeed(CurrentPricingDecisionAttemptSource, adapters.attemptSource),
        Layer.succeed(CurrentPricingDecisionTierSetReader, adapters.tierReader),
        Layer.succeed(CurrentPricingDecisionFeeSetReader, adapters.feeReader),
        Layer.succeed(CurrentPricingDecisionDiscountSetReader, adapters.discountReader),
        Layer.succeed(CurrentPricingDecisionExternalOwnerEvidence, adapters.externalOwnerEvidence),
        Layer.succeed(CurrentPricingDecisionZeroFloorSetReader, adapters.floorReader),
        Layer.succeed(CurrentPricingDecisionWholeComposition, adapters.composition),
        Layer.succeed(ExactPriceResolver, adapters.exactPrice),
        Layer.succeed(PricingPromotionCurrentEvaluation, adapters.promotion),
      ),
    ),
  );

export const currentPricingDecisionWholeEvaluationForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  compositionRevision: string,
) =>
  scopedAdapters(transaction, scope, compositionRevision).pipe(
    Effect.map((adapters) =>
      makeCurrentPricingDecisionWholeEvaluationService({
        attemptSource: adapters.attemptSource,
        composition: adapters.composition,
        discountReader: adapters.discountReader,
        externalOwnerEvidence: adapters.externalOwnerEvidence,
        feeReader: adapters.feeReader,
        floorReader: adapters.floorReader,
        promotionEvaluation: adapters.promotion,
        tierReader: adapters.tierReader,
      }),
    ),
  );
