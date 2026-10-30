import { PricingOwnerMaterialEvidenceFenceGatewayUnavailable } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import { makePricingCurrentDecisionCatalogOwnerFinalFenceGateway } from '../../src/integrations/current-pricing-decision-owner-final-fence.ts';
import {
  PricingCurrentMarketEvidenceRequestSchema,
  PricingCurrentMarketEvidenceResponseSchema,
} from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import type { PricingCurrentMarketEvidenceRequest } from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import { PricingCommercialTotalReadySchema } from '@app/pricing-contracts/domain/commercial-total';
import {
  PricingDiscountAudienceEvidenceBindingSchema,
  PricingDiscountCurrentResolutionSchema,
} from '@app/pricing-contracts/domain/discount';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { PricingEvaluationAttemptSchema } from '@app/pricing-contracts/domain/material-change';
import {
  PricingSetBackedMaterialEvidenceFenceSourceSchema,
  PricingExactPriceOwnerReadReceiptSchema,
} from '@app/pricing-contracts/domain/material-evidence';
import { PricingUnitPriceCalculationAttemptSchema } from '@app/pricing-contracts/domain/unit-price-calculation';
import {
  PricingCommercialFeeCalculationInputSchema,
  pricingCommercialFeeCurrentSetPredicateRef,
} from '@app/pricing-contracts/domain/commercial-fee';
import { PricingZeroFloorCurrentAuthorizationSetSchema } from '@app/pricing-contracts/domain/line-composition';
import { QuantityBasisCompatibilityResponseSchema } from '@app/catalog/api/quantity-basis-compatibility';
import {
  makeCurrentPricingDecisionExternalOwnerEvidenceLivePort,
  currentPricingDecisionExternalOwnerEvidencePortFromEnvironment,
} from '../../src/integrations/current-pricing-decision-external-owner-evidence-live.ts';
import {
  currentPricingDecisionWholeEvaluationAdaptersForScope,
  makeCurrentPricingDecisionWholeComposition,
} from '../../src/integrations/current-pricing-decision-whole-evaluation-adapters.ts';
import {
  CurrentPricingDecisionAttemptSource,
  CurrentPricingDecisionTierSetReader,
  CurrentPricingDecisionWholeComposition,
  CurrentPricingDecisionOwnerReadFailure,
  makeCurrentPricingDecisionWholeEvaluationService,
} from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import type { CurrentPricingDecisionExternalOwnerEvidencePort } from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import {
  makePricingExternalOwnerEvidenceValidationService,
  PricingExternalOwnerEvidenceValidation,
} from '../../src/services/external-owner-evidence-validation.service.ts';
import { CommercialFeeSetAuthoritySchema } from '../../src/services/commercial-fee-persistence.service.ts';
import {
  CommercialContextGatewayCredentialService,
  PricingCommercialContextUnavailable,
} from '../../shared/domain/commercial-context-gateway-credential.ts';
import { CatalogSelectionGatewayCredentialService } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import { JoinedPrerequisites1225 } from '../support/joined-prerequisites-1225.ts';
import type { JoinedObservation1225 } from '../support/joined-prerequisites-1225.ts';
import type { CatalogSelectionGatewayCredentialIssuer } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import { assessPricingQuantityBasis } from '../../src/services/quantity-unit-package-basis.service.ts';
import {
  unitPriceCalculationAttempt,
  unitPriceFixtureTenantId,
  unitPriceFixtureEffectiveAt,
  unitPriceFixtureProductRef,
  unitPriceFixtureVariantRef,
  unitPriceFixtureUnitRef,
} from '../unit/support/unit-price-calculation.fixture.ts';
import { authorizationSetFor } from '../unit/support/issue-779-line-value.fixture.ts';
import {
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  ReadRuntime,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  TrustedPrincipalContextSchema,
  ReadHandlerUnavailable,
  defineRead,
  defineTenantModuleEntrypoint,
  makeContextPermissionRelationshipMutationLive,
  parseDatabaseConfig,
} from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor, ReadHandlerContext } from '@app/core-runtime';
import {
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
  makeActiveApplicationCompositionLayer,
} from '@app/core-runtime/modules/active-application-composition';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { CatalogQuantityHandoffReadySchema } from '@app/catalog/domain/catalog-quantity-handoff';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import {
  PricingPurposeEquivalenceRequestSchema,
  PricingPurposeEquivalenceResponseSchema,
} from '@app/catalog/api/pricing-purpose-equivalence';
import { executePricingPurposeEquivalenceWithAuthorization } from '@app/catalog/api/pricing-purpose-equivalence-client';
import { executeQuantityPreparationWithAuthorization } from '@app/catalog/api/quantity-preparation-client';
import { executeQuantityBasisCompatibilityWithAuthorization } from '@app/catalog/api/quantity-basis-compatibility-client';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  SupportedGatewayContextClaimsSchema,
  decodeSupportedGatewayContextClaims,
} from '@app/shared-contracts';
import { PriceIdentityKeySchema, PricePositiveDecimalSchema } from '@app/pricing-contracts/domain/price-definition';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import {
  SetSupportedCurrenciesV2PayloadSchema,
  PricingInstantSchema,
} from '@app/pricing-contracts/domain/currency-support';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import {
  QuantityTierIdentityKeySchema,
  QuantityTierNormalizedQuantitySchema,
  QuantityTierSelectionResultSchema,
} from '@app/pricing-contracts/domain/quantity-tier';
import { sumQuantityTierNormalizedQuantities } from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import {
  Clock,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import type { Cause } from 'effect';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { pricePersistenceForScope } from '../../src/services/price-persistence.service.ts';
import type { DefinePricePersistenceCommand } from '../../src/services/price-persistence.service.ts';
import { quantityTierPersistenceForScope } from '../../src/services/quantity-tier-persistence.service.ts';
import { currencySupportPersistenceForScope } from '../../src/persistence/currency-support-persistence.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';
import { selectQuantityTier } from '../../src/services/quantity-tier-selection.service.ts';

// Closed private process DTOs are decoded locally; no foreign private source import.
const protocolVersion = 'ontos.catalog.whole-candidate.fixture.v1' as const;
const version = protocolVersion;
const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const WholeCandidateCatalogBootstrapSchema = Schema.Struct({
  actor: TrustedPrincipalContextSchema,
  composition: ActiveApplicationCompositionSnapshotSchema,
  databaseName: Schema.String.check(Schema.isPattern(/^ontos_test_[a-z0-9_]+$/u)),
  issuer: Schema.String,
  jwks: Schema.String,
  legalEntityId: legalEntityIdSchema,
  runtimeConnectionString: Schema.RedactedFromValue(Schema.String),
  scheduledConfiguration: Schema.optionalKey(Schema.Literal(true)),
  type: Schema.Literal('bootstrap'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogPrepareSchema = Schema.Struct({
  authorizations: Schema.Tuple([
    Schema.RedactedFromValue(Schema.String),
    Schema.RedactedFromValue(Schema.String),
    Schema.RedactedFromValue(Schema.String),
  ]),
  type: Schema.Literal('prepare'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogReviseSchema = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  type: Schema.Literal('revise-first-unit'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const StopSchema = Schema.Struct({ type: Schema.Literal('stop'), version: Schema.Literal(protocolVersion) }).annotate({
  parseOptions: { onExcessProperty: 'error' },
});
const WholeCandidateCatalogCommandSchema = Schema.Union([
  WholeCandidateCatalogBootstrapSchema,
  WholeCandidateCatalogPrepareSchema,
  WholeCandidateCatalogReviseSchema,
  StopSchema,
]);
const selectionsSchema = Schema.Tuple([CatalogSelectionSchema, CatalogSelectionSchema, CatalogSelectionSchema]);
const unitsSchema = Schema.Tuple([ProductUnitRefSchema, ProductUnitRefSchema, ProductUnitRefSchema]);
const publicFields = {
  actor: TrustedPrincipalContextSchema,
  buildMarker: Schema.String,
  compositionRevision: Schema.String,
  legalEntityId: legalEntityIdSchema,
  port: Schema.Int,
  selections: selectionsSchema,
  units: unitsSchema,
  version: Schema.Literal(protocolVersion),
};
const WholeCandidateCatalogProducedSchema = Schema.Struct({
  ...publicFields,
  type: Schema.Literal('produced'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogReadySchema = Schema.Struct({
  ...publicFields,
  handoffs: Schema.Tuple([
    CatalogQuantityHandoffReadySchema,
    CatalogQuantityHandoffReadySchema,
    CatalogQuantityHandoffReadySchema,
  ]),
  type: Schema.Literal('ready'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogFailureSchema = Schema.Struct({
  reasonCode: Schema.Literals(['RECEIVING_RELEASE_NOT_APPROVED', 'FIXTURE_UNAVAILABLE']),
  stage: Schema.String,
  type: Schema.Literal('failed'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const ActionKeySchema = Schema.String.pipe(Schema.brand('ActionKey'));
const WholeCandidateCatalogDescriptionSchema = Schema.Struct({
  actionKeys: Schema.Array(ActionKeySchema),
  appId: Schema.Literal('catalog'),
  buildMarker: Schema.String,
  type: Schema.Literal('description'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogResponseSchema = Schema.Union([
  WholeCandidateCatalogFailureSchema,
  WholeCandidateCatalogProducedSchema,
  WholeCandidateCatalogReadySchema,
  Schema.Struct({
    ruleRevision: Schema.Int,
    type: Schema.Literal('revised'),
    version: Schema.Literal(protocolVersion),
  }),
]);

const catalogActionKeys = [
  'create-product',
  'create-attribute-definition',
  'create-product-type',
  'set-product-type',
  'create-variant',
  'govern-product-attribute-applicability',
  'set-variant-attribute-override',
  'govern-variant-axes',
  'govern-variant-allowed-values',
  'confirm-variant-combination',
  'set-product-localized-facts',
  'update-product',
  'create-product-unit',
  'set-product-unit-target-divisibility',
  'create-product-category',
  'add-product-category-assignment',
  'revise-product-unit',
  'publish-product-configuration',
].map((slug) => ActionKeySchema.make(`commerce.catalog.${slug}`));
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const appRoot = new URL('../../../../', import.meta.url).pathname;
const componentPermission = 'pricing.whole_candidate_component_test.read';
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(staffAuthenticationNamespaceRegistryLayer(['catalog', 'pricing'])),
);
class WholeCandidateReceiverTestUnavailable extends Schema.TaggedError<WholeCandidateReceiverTestUnavailable>()(
  'WholeCandidateReceiverTestUnavailable',
  { stage: Schema.String },
) {}
const unavailable = (stage: string) => new WholeCandidateReceiverTestUnavailable({ stage });

// Component setup intentionally uses Pricing's real scoped persistence, not registered
// DefinePrice admission. No Market/CCC authority or published whole result is invented.
const makeNativePrice = Effect.fn('WholeCandidate.nativePrice')(function* makeNativePrice(
  scope: OperationalScope,
  handoff: typeof CatalogQuantityHandoffReadySchema.Type,
  operationTime: string,
) {
  const actionInvocationId = yield* nextId;
  const priceId = yield* nextId;
  const identityKey = yield* Schema.decodeUnknownEffect(PriceIdentityKeySchema)({
    catalogSelection: handoff.selection,
    commercialScope: { channelId: 'B2C', marketId: 'component-test', sellingLegalEntityId: scope.legalEntityId },
    currencyCode: 'CZK',
    priceGroupSelector: { kind: 'NO_GROUP' },
    unitBasis: { quantity: '1', unitRef: handoff.unitRef },
  });
  const assertion = yield* Schema.decodeUnknownEffect(PriceSourceAssertionInputSchema)({
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'TEST:1225:Pricing-owned-component', mappingContractVersion: '1' },
    originalAssertion: {
      monetaryAmount: { amount: '100', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      unitBasis: identityKey.unitBasis,
    },
    sourceAssertionId: yield* nextId,
    sourceAuthority: { sourceAuthorityRef: 'TEST:1225:Pricing-owner-component', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: actionInvocationId,
      sourceRecordRef: priceId,
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'TEST:1225:Pricing-native-setup' },
    },
    timing: { importedAt: operationTime, ownerBusinessEffectiveAt: operationTime, sourceEffectiveAt: operationTime },
  });
  const trustedOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe(operationTime));
  const prepared = preparePriceSourceEvidence({
    actingPrincipalId: scope.principalId,
    effectiveFrom: operationTime,
    identityKey,
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    sourceAssertion: assertion,
    tenantId: scope.tenantId,
    trustedOperationAt,
  });
  if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
    return yield* Effect.die('Native Pricing-owned source must be ready');
  }
  return {
    actingPrincipalId: scope.principalId,
    actionInvocationId,
    effectiveFrom: operationTime,
    identityKey,
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    priceRef: {
      moduleId: 'commerce.pricing',
      resourceId: priceId,
      resourceType: 'commerce.pricing.price',
      tenantId: scope.tenantId,
    },
    reason: 'Native Pricing component setup only; registered owner admission is separately required.',
    requestCorrelationId: actionInvocationId,
    sourceEvidence: prepared.evidence,
    trustedOperationAt,
  } satisfies DefinePricePersistenceCommand;
});

// Only Fee/Discount/Market/purchase-context prerequisites are declared contracts.
// Price, Tier, Currency and Catalog are real native/public production reads.
const evaluateNativeWhole1225 = Effect.fn('WholeCandidate.joinedConsumer')(function* evaluateNativeWhole1225(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  compositionRevision: string | undefined,
  request: typeof CurrentPricingDecisionRequestSchema.Type,
) {
  const configured = yield* Effect.serviceOption(JoinedPrerequisites1225);
  if (Option.isNone(configured)) {
    return yield* unavailable('joined-prerequisites-absent');
  }
  const config = configured.value;
  const activeComposition = yield* ActiveApplicationCompositionService;
  const activeSnapshot = yield* activeComposition.load.pipe(
    Effect.mapError(() => unavailable('active-composition-unavailable')),
  );
  const actualRevision = activeSnapshot.composition.revision;
  if (compositionRevision !== undefined && compositionRevision !== actualRevision) {
    return yield* unavailable('composition-mismatch');
  }

  const adapters = yield* currentPricingDecisionWholeEvaluationAdaptersForScope(
    transaction,
    scope,
    actualRevision,
  ).pipe(
    Effect.provideService(CatalogSelectionGatewayCredentialService, config.catalogIssuer),
    Effect.provideService(PricingExternalOwnerEvidenceValidation, makePricingExternalOwnerEvidenceValidationService()),
  );
  const context = yield* Layer.build(adapters);
  const composition = Context.get(context, CurrentPricingDecisionWholeComposition);
  const { decision } = request;
  const at = decision.operationTime;
  const crypto = yield* Crypto.Crypto;
  const feeIdentities = new Map<string, { readonly feeId: string; readonly revisionId: string }>();
  const discountId = yield* nextId;
  const discountRevisionId = yield* nextId;
  const counterpartyId = yield* nextId;
  let completed: typeof PricingCommercialTotalReadySchema.Type | undefined;
  const stop = new CurrentPricingDecisionOwnerReadFailure({
    kind: 'UNAVAILABLE',
    ownerRefs: ['TEST:1225:unperformed-final-authority'],
    reason: 'Joined native/public whole calculation observed; remaining final authority is separate evidence',
  });
  const nativeTier = Context.get(context, CurrentPricingDecisionTierSetReader);
  const whole = makeCurrentPricingDecisionWholeEvaluationService({
    attemptSource: Context.get(context, CurrentPricingDecisionAttemptSource),
    composition: {
      ...composition,
      buildMaterialEvidenceRequest: (input) =>
        Effect.sync(() => {
          completed = input.commercialTotal;
          config.observe(input);
        }).pipe(Effect.andThen(Effect.fail(stop))),
    },
    discountReader: {
      loadCurrent: ({ feeResults, unitPrices }) =>
        Effect.gen(function* declaredWholeDiscount1225() {
          const [unit] = unitPrices;
          assert(unit !== undefined && 'usedPrice' in unit.input.exactPrice.path);
          const { usedPrice } = unit.input.exactPrice.path;
          const audience = {
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: counterpartyId,
              resourceType: 'party.registry.counterparty',
              tenantId: decision.tenantId,
            },
            kind: 'COUNTERPARTY',
          } as const;
          const identityKey = {
            audience,
            basis: { kind: 'WHOLE_PURCHASE' },
            commercialScope: decision.commercialScope,
            currencyCode: decision.currencyCode,
            effectKind: 'FIXED_MONETARY_AMOUNT',
            family: 'CONTRACTUAL_DISCOUNT',
            monetaryBoundary: 'PRE_TAX',
            scope: 'WHOLE_PURCHASE',
          } as const;
          const audienceBinding = yield* Schema.decodeUnknownEffect(PricingDiscountAudienceEvidenceBindingSchema)({
            applicabilityBasis: {
              basis: identityKey.basis,
              commercialScope: decision.commercialScope,
              currencyCode: decision.currencyCode,
              observedAt: at,
            },
            basePricePath: {
              kind: 'NO_GROUP_PRICE',
              priceRef: usedPrice.priceRef,
              priceRevisionId: usedPrice.priceRevision.revisionId,
            },
            evidence: {
              audience,
              kind: 'COUNTERPARTY_OWNER_EVIDENCE',
              observedAt: at,
              ownerRevision: 'TEST:1225:declared-counterparty-prerequisite',
              source: 'PARTY_REGISTRY',
            },
            identityKey,
          });
          const currentResolution = yield* Schema.decodeUnknownEffect(PricingDiscountCurrentResolutionSchema)({
            observedAt: at,
            outcome: 'DISCOUNT_CURRENT',
            revision: {
              definition: {
                discountId,
                identityKey,
                revision: {
                  configuredEffect: {
                    kind: 'FIXED_MONETARY_AMOUNT',
                    level: { amount: '10', currencyCode: decision.currencyCode },
                  },
                  effectiveFrom: at,
                  revision: 1,
                  revisionId: discountRevisionId,
                },
              },
              effectivePeriod: { effectiveFrom: at, effectiveTo: null },
              lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
            },
          });
          return {
            applicabilityInputs: [
              {
                audienceBinding,
                currencySupport: unit.input.exactPrice.currencySupport,
                currentResolution,
                wholePurchaseIntermediates: feeResults.flatMap((fee) =>
                  fee.outcome === 'COMMERCIAL_FEES_APPLIED'
                    ? [
                        {
                          amount: fee.discountableLineBasis,
                          occurrenceId: fee.input.occurrenceId,
                          recipientKind: 'MERCHANDISE' as const,
                        },
                      ]
                    : [],
                ),
              },
            ],
            currentSets: [],
          };
        }).pipe(Effect.orDie, Effect.provideService(Crypto.Crypto, crypto)),
    },
    externalOwnerEvidence: config.external,
    feeReader: {
      loadCurrent: (_request, _attempt, unit) =>
        Effect.gen(function* declaredFeePrerequisite1225() {
          const { line } = unit.input;
          const target = { variantRef: line.catalog.selection.variantRef };
          let identity = feeIdentities.get(target.variantRef.resourceId);
          if (identity === undefined) {
            identity = { feeId: yield* nextId, revisionId: yield* nextId };
            feeIdentities.set(target.variantRef.resourceId, identity);
          }
          const predicateRef = pricingCommercialFeeCurrentSetPredicateRef({
            commercialScope: decision.commercialScope,
            currencyCode: decision.currencyCode,
            target,
          });
          assert('usedPrice' in unit.input.exactPrice.path);
          const { usedPrice } = unit.input.exactPrice.path;
          const input = yield* Schema.decodeUnknownEffect(PricingCommercialFeeCalculationInputSchema)({
            baseLineValue: unit.baseLineValue,
            currencySupport: unit.input.exactPrice.currencySupport,
            decision,
            feeSet: {
              commercialScope: decision.commercialScope,
              completenessEvidence: {
                observedAt: at,
                ownerRevision: 'TEST:1225:declared-fee-set',
                scope: { kind: 'EXACT_PREDICATE', predicateRef },
              },
              currencyCode: decision.currencyCode,
              currentnessEvidence: {
                observedAt: at,
                ownerRevision: 'TEST:1225:declared-fee-set',
                predicateRef,
                revalidatedAt: at,
                verificationMode: 'OWNER_CURRENT_SET_REVALIDATED',
              },
              fees: [
                {
                  definition: {
                    catalogTargetEvidence: {
                      capturedAt: at,
                      catalogOwnerRevision: line.catalog.ownerRevision,
                      productRef: line.catalog.selection.productRef,
                      snapshotId: 'TEST:1225:declared-fee-catalog-snapshot',
                      targetId: 'TEST:1225:declared-fee-target',
                      variantRef: target.variantRef,
                    },
                    feeRef: {
                      moduleId: 'commerce.pricing',
                      resourceId: identity.feeId,
                      resourceType: 'commerce.pricing.commercial-fee',
                      tenantId: decision.tenantId,
                    },
                    identityKey: {
                      calculationBasis: { kind: 'FIXED_PER_LINE' },
                      commercialScope: decision.commercialScope,
                      currencyCode: decision.currencyCode,
                      family: 'RECYCLING_FEE',
                      monetaryBoundary: 'PRE_TAX',
                      target,
                    },
                    revision: {
                      configuredAmount: { amount: '3', currencyCode: decision.currencyCode },
                      effectiveFrom: at,
                      revision: 1,
                      revisionId: identity.revisionId,
                    },
                  },
                  effectivePeriod: { effectiveFrom: at, effectiveTo: null },
                  lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
                },
              ],
              observedAt: at,
              target,
            },
            occurrenceId: line.occurrenceId,
            pricePath: {
              priceRef: usedPrice.priceRef,
              priceRevisionId: usedPrice.priceRevision.revisionId,
              source: 'NO_GROUP_PRICE',
            },
          });
          return {
            authority: {
              generation: 1,
              observedAt: at,
              ownerRevision: 'TEST:1225:declared-fee-set',
              ownerRootRef: 'TEST:1225:declared-fee-root',
              predicateRef,
              verificationRef: 'TEST:1225:declared-fee-proof',
            },
            factProofs: [],
            input,
          };
        }).pipe(Effect.orDie, Effect.provideService(Crypto.Crypto, crypto)),
    },
    floorReader: {
      loadCurrent: (_request, _attempt, raw) =>
        Effect.succeed(
          raw.lines.map((line) => ({
            authority: {
              generation: 1,
              observedAt: at,
              ownerRevision: 'TEST:1225:declared-floor-set',
              ownerRootRef: 'TEST:1225:declared-floor-root',
              predicateRef: 'TEST:1225:declared-floor-predicate',
              verificationRef: 'TEST:1225:declared-floor-proof',
            },
            authorizationSet: authorizationSetFor(line, { authorizations: [], observedAt: at }),
            factProofs: [],
            occurrenceId: line.occurrenceId,
          })),
        ),
    },
    promotionEvaluation: { evaluate: () => Effect.die('No Promotion is selected by this composition') },
    tierReader: nativeTier,
  });
  const result = yield* whole.loadFresh(
    request,
    {
      purchaseContextEvidence: config.purchaseContextEvidence,
      sellingLegalEntityId: decision.commercialScope.sellingLegalEntityId,
      tenantId: decision.tenantId,
    },
    1,
  );
  if (completed === undefined) {
    return yield* unavailable(
      `joined-whole:${'reason' in result.attempt ? result.attempt.reason : result.attempt.kind}`,
    );
  }
  return completed;
});

const ComponentReadInputSchema = Schema.Struct({
  effectiveAt: PricingInstantSchema,
  handoff: CatalogQuantityHandoffReadySchema,
  priceRef: PriceRefSchema,
  quantity: PricePositiveDecimalSchema,
  wholeRequest: Schema.optionalKey(CurrentPricingDecisionRequestSchema),
});
const componentServicesForScope = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  compositionRevision: string | undefined,
) =>
  Effect.all({
    evaluateWhole: Effect.succeed((request: typeof CurrentPricingDecisionRequestSchema.Type) =>
      evaluateNativeWhole1225(transaction, scope, compositionRevision, request).pipe(Effect.scoped),
    ),
    prices: pricePersistenceForScope(transaction, scope),
    tiers: quantityTierPersistenceForScope(transaction, scope),
  });
type ComponentServices = Effect.Success<ReturnType<typeof componentServicesForScope>>;
const componentRead = defineRead(
  {
    accessKind: 'detail',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: componentPermission },
      entrypointKey: 'commerce.pricing.test.whole-candidate-components',
      moduleKey: 'commerce.pricing',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'commerce.pricing.test.whole-candidate-components.v1' },
    inputSchema: ComponentReadInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'commerce.pricing',
    permissionTarget: 'module',
    policies: [],
    readKey: 'commerce.pricing.test.whole-candidate-components',
    resultSchema: Schema.Union([QuantityTierSelectionResultSchema, PricingCommercialTotalReadySchema]),
    schemaVersion: '1',
  },
  (input, context: ReadHandlerContext<ComponentServices>) =>
    Effect.gen(function* readRealNativeTier() {
      if (input.wholeRequest !== undefined) {
        return {
          evidence: { resultCount: input.wholeRequest.decision.lines.length },
          result: yield* context.services.evaluateWhole(input.wholeRequest),
        };
      }
      const [schedule, tiers] = yield* Effect.all([
        context.services.prices.readSchedule(
          input.priceRef,
          DateTime.toDateUtc(DateTime.makeUnsafe(input.effectiveAt)),
        ),
        context.services.tiers.readCurrentSet({ effectiveAt: input.effectiveAt, priceRef: input.priceRef }),
      ]);
      if (
        schedule.outcome !== 'PRICE_SCHEDULE_CURRENT' ||
        schedule.schedule.current === undefined ||
        tiers.outcome !== 'QUANTITY_TIER_SET_CURRENT'
      ) {
        return yield* unavailable('native-owner-schedule-or-tier-unavailable');
      }
      const exactPrice = {
        path: {
          priceGroupSelector: schedule.schedule.current.definition.identityKey.priceGroupSelector,
          requiredAbsenceEvidence: [],
        },
        price: schedule.schedule.current,
        scheduleRevision: schedule.schedule.scheduleRevision,
      };
      const result = yield* selectQuantityTier({
        input: {
          attempt: {
            evaluatedAt: input.effectiveAt,
            exactPrice,
            normalizedQuantity: {
              quantity: input.quantity,
              quantityBasis: {
                catalogQuantityBasis: input.handoff.quantityBasis,
                priceUnitBasis: exactPrice.price.definition.identityKey.unitBasis,
              },
            },
            tierSetPriceRef: input.priceRef,
          },
          tierSet: tiers.tierSet,
        },
        outcome: 'TIER_SET_CURRENT',
      });
      return { evidence: { resultCount: 1 }, result };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: Schema.is(WholeCandidateReceiverTestUnavailable)(cause)
              ? cause.stage
              : 'Native whole-candidate component authority unavailable',
          }),
      ),
    ),
  componentServicesForScope,
  () => ({ kind: 'module', moduleId: 'commerce.pricing' }),
);

const nativeReadRuntime = (
  runtimeConnectionString: string,
  composition: typeof ActiveApplicationCompositionSnapshotSchema.Type,
) => {
  const database = Layer.effect(DatabaseConfig, parseDatabaseConfig({ DATABASE_URL: runtimeConnectionString }));
  const persistence = CorePersistenceLive.pipe(Layer.provide(database));
  const states = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
  const gate = ModuleStateGateLive.pipe(Layer.provide(states));
  const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
  const scopes = OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(persistence, ContextAccessLive)));
  const common = Layer.mergeAll(
    persistence,
    ContextAccessLive,
    gate,
    gateway,
    scopes,
    staffAuthenticationNamespaceRegistryLayer(['pricing']),
    makeActiveApplicationCompositionLayer(Effect.succeed(composition)),
  );
  return ReadRuntimeLive.pipe(Layer.provide(common), Layer.provide(NodeCrypto.layer));
};

const produceNativeComponents = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  handoffs: readonly (typeof CatalogQuantityHandoffReadySchema.Type)[],
  operationTime: string,
) =>
  Effect.gen(function* produceNativeComponentsProgram() {
    const prices = yield* pricePersistenceForScope(transaction, scope);
    const tiers = yield* quantityTierPersistenceForScope(transaction, scope);
    return yield* Effect.forEach(
      handoffs,
      (handoff) =>
        Effect.gen(function* produceOnePriceAndTier() {
          const command = yield* makeNativePrice(scope, handoff, operationTime);
          expect(yield* prices.define(command)).toMatchObject({ outcome: 'CREATED' });
          const identityKey = yield* Schema.decodeUnknownEffect(QuantityTierIdentityKeySchema)({
            priceRef: command.priceRef,
            quantityBasis: {
              catalogQuantityBasis: handoff.quantityBasis,
              priceUnitBasis: command.identityKey.unitBasis,
            },
            thresholdQuantity: '2',
          });
          expect(
            yield* tiers.define({
              actingPrincipalId: scope.principalId,
              actionInvocationId: yield* nextId,
              effectivePeriod: { effectiveFrom: operationTime, effectiveTo: null },
              expectedState: { state: 'ABSENT' },
              identityKey,
              reason: 'Pricing native component threshold',
              requestCorrelationId: yield* nextId,
              resultingUnitPrice: { amount: '75', currencyCode: 'CZK' },
              trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
            }),
          ).toMatchObject({ outcome: 'QUANTITY_TIER_CREATED' });
          return { handoff, priceRef: command.priceRef };
        }),
      { concurrency: 1 },
    );
  });

interface CatalogSigningInput {
  readonly actor: typeof TrustedPrincipalContextSchema.Type;
  readonly buildMarker: string;
  readonly compositionRevision: string;
  readonly issuedAt: DateTime.Utc;
  readonly issuer: string;
  readonly kid: string;
  readonly privateKey: Parameters<typeof globalThis.crypto.subtle.sign>[1];
}
const issueCatalogAuthorization = (input: CatalogSigningInput) =>
  Effect.gen(function* issueCatalogAuthorizationProgram() {
    const { actor } = input;
    const now = Math.floor(DateTime.toEpochMillis(input.issuedAt) / 1000);
    const headerSchema = Schema.Struct({
      alg: Schema.Literal('EdDSA'),
      kid: Schema.String,
      typ: Schema.Literal('JWT'),
    });
    const header = Buffer.from(
      yield* Schema.encodeEffect(Schema.fromJsonString(headerSchema))({ alg: 'EdDSA', kid: input.kid, typ: 'JWT' }),
    ).toString('base64url');
    const claims = yield* decodeSupportedGatewayContextClaims({
      aud: 'catalog',
      compositionRevision: input.compositionRevision,
      exp: now + GATEWAY_ASSERTION_TTL_SECONDS,
      iat: now,
      iss: input.issuer,
      jti: yield* nextId,
      principal: actor,
      sub: actor.principalId,
      targetBuildMarker: input.buildMarker,
      ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
    });
    const payload = Buffer.from(
      yield* Schema.encodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claims),
    ).toString('base64url');
    const content = `${header}.${payload}`;
    const signature = yield* Effect.tryPromise({
      catch: () => unavailable('assertion-sign'),
      try: () => globalThis.crypto.subtle.sign('Ed25519', input.privateKey, new TextEncoder().encode(content)),
    });
    return `Bearer ${content}.${Buffer.from(signature).toString('base64url')}`;
  });

interface CatalogConsumer1262Input {
  readonly compatibility: typeof QuantityBasisCompatibilityResponseSchema.Type;
  readonly composition: typeof ActiveApplicationCompositionSnapshotSchema.Type;
  readonly correlation: string;
  readonly credentials: readonly [Redacted.Redacted, Redacted.Redacted];
  readonly endpoint: { readonly baseUrl: URL; readonly compositionRevision: string };
  readonly handoff: typeof CatalogQuantityHandoffReadySchema.Type;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

// Non-Catalog arithmetic prerequisites only. Actual owner handoffs/bases replace every
// Catalog-shaped fixture field; no Catalog receipt/generation/window is constructed.
const rebindCatalogConsumerPrerequisite1262 = (
  value: Schema.Json,
  replacements: readonly (readonly [string, string])[],
  handoff: typeof CatalogQuantityHandoffReadySchema.Type,
): Schema.Json => {
  if (Schema.is(Schema.String)(value)) {
    let rebound = value;
    for (const [from, to] of replacements) {
      rebound = rebound.replaceAll(from, to);
    }
    return rebound;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rebindCatalogConsumerPrerequisite1262(item, replacements, handoff));
  }
  if (Schema.is(Schema.Record(Schema.String, Schema.Json))(value)) {
    if (value['status'] === 'READY' && 'equivalentSelectionKey' in value) {
      return handoff;
    }
    if (Option.isSome(Schema.decodeUnknownOption(CatalogSelectionSchema, { onExcessProperty: 'error' })(value))) {
      return handoff.selection;
    }
    if ('targetDivisibilityRevision' in value && 'unitRuleRevision' in value && 'targetRef' in value) {
      return handoff.quantityBasis;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rebindCatalogConsumerPrerequisite1262(item, replacements, handoff),
      ]),
    );
  }
  return value;
};

const catalogConsumerPreconditions1262 = Effect.fn('CatalogConsumer1262.preconditions')(
  function* catalogConsumerPreconditions1262(input: CatalogConsumer1262Input) {
    const owner = {
      legalEntityId: input.legalEntityId,
      marketRef: { resourceId: '1262:declared-market-prerequisite' },
      now: DateTime.makeUnsafe(input.handoff.evidence.assessedAt),
      principal: { principalId: input.principalId },
      tenantId: input.tenantId,
    };
    const channel = 'B2C';
    const at = DateTime.formatIso(owner.now);
    const requestedAt = DateTime.formatIso(owner.now);
    const replacements = [
      [unitPriceFixtureProductRef.resourceId, input.handoff.selection.productRef.resourceId],
      [unitPriceFixtureVariantRef.resourceId, input.handoff.selection.variantRef.resourceId],
      [unitPriceFixtureUnitRef.resourceId, input.handoff.unitRef.resourceId],
      [unitPriceFixtureTenantId, owner.tenantId],
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner.legalEntityId],
      ['cz-launch', owner.marketRef.resourceId],
      ['2026-09-28T12:00:00.050Z', requestedAt],
      ['2026-09-28T12:00:00.100Z', requestedAt],
      [unitPriceFixtureEffectiveAt, at],
      [
        '2026-09-01T00:00:00.000Z',
        DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(owner.now) - 86_400_000)),
      ],
      ['2026-10-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'],
      ['B2C', channel],
    ] as const;
    const initial = yield* unitPriceCalculationAttempt({
      groupPath: false,
      priceAmount: '100',
      quantity: input.handoff.quantity.resulting,
      tiers: [],
    });
    const encoded = yield* Schema.encodeEffect(PricingUnitPriceCalculationAttemptSchema)(initial);
    const json = yield* Schema.decodeUnknownEffect(Schema.Json)(encoded);
    const rebound = yield* Schema.decodeUnknownEffect(PricingUnitPriceCalculationAttemptSchema)(
      rebindCatalogConsumerPrerequisite1262(json, replacements, input.handoff),
    );
    assert('usedPrice' in rebound.exactPrice.path);
    const { usedPrice } = rebound.exactPrice.path;
    const quantityBasis = yield* assessPricingQuantityBasis({
      attempt: {
        catalog: input.handoff,
        effectiveAt: at,
        occurrenceId: rebound.line.occurrenceId,
        price: {
          identityKey: usedPrice.request.exactKey,
          priceRef: usedPrice.priceRef,
          revision: usedPrice.priceRevision,
        },
      },
      ownerDecision: input.compatibility,
    });
    assert(quantityBasis.outcome === 'NO_CONVERSION_REQUIRED');
    const unit = yield* Schema.decodeEffect(Schema.toType(PricingUnitPriceCalculationAttemptSchema))({
      ...rebound,
      line: { ...rebound.line, catalog: input.handoff },
      lineQuantity: {
        quantity: input.handoff.quantity.resulting,
        quantityBasis: { catalogQuantityBasis: input.handoff.quantityBasis, priceUnitBasis: rebound.line.pricingBasis },
      },
      quantityBasis,
    });
    assert('usedPrice' in unit.exactPrice.path);
    assert(unit.tierSelection.outcome === 'BASE_PRICE_RETAINED');
    assert(unit.lineQuantity !== undefined);
    assert(unit.quantityBasis.outcome === 'NO_CONVERSION_REQUIRED');
    const subject = {
      guestEvidenceRef: '1262:guest-evidence',
      guestSessionRef: '1262:guest-session',
      kind: 'GUEST' as const,
    };
    const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
      decision: {
        commercialScope: {
          channelId: channel,
          marketId: owner.marketRef.resourceId,
          sellingLegalEntityId: owner.legalEntityId,
        },
        currencyCode: 'CZK',
        lines: [unit.line],
        monetaryBoundary: 'PRE_TAX',
        operationTime: at,
        purchasingContext: {
          accessDecision: { decisionRef: '1262:access', decisionRevision: '1' },
          actor: subject,
          commercialSettingsDecision: { decisionRef: '1262:commercial-settings', decisionRevision: '1' },
          contextRef: '1262:purchase-context',
          contextRevision: '1',
          currencyResolution: { currencyCode: 'CZK', resolutionRef: '1262:currency', resolutionRevision: '1' },
          subject,
        },
        tenantId: owner.tenantId,
      },
      subject,
    });
    const purchaseContextEvidence = yield* Schema.decodeEffect(PricingPurchaseContextVerificationEvidenceSchema)({
      currentness: { evaluatedAt: at, observedAt: at, validFrom: at, validTo: null },
      ownerRef: request.decision.purchasingContext.contextRef,
      ownerRevisionRef: request.decision.purchasingContext.contextRevision,
      subjectAuthority: {
        guestEvidenceAuthorityRef: '1262:guest-authority',
        guestSessionAuthorityRef: '1262:session-authority',
        kind: 'GUEST',
        subject,
        subjectAuthorityRevisionRef: '1',
      },
      verificationRef: '1262:purchase-context-verification',
      verifiedScope: {
        channelId: channel,
        legalEntityId: owner.legalEntityId,
        marketId: owner.marketRef.resourceId,
        tenantId: owner.tenantId,
      },
    });
    const used = unit.exactPrice.path.usedPrice;
    const priceReceipt = yield* Schema.decodeEffect(PricingExactPriceOwnerReadReceiptSchema)({
      authority: {
        generation: 1,
        kind: 'PERSISTENT',
        observedAt: used.evidence.observedAt,
        ownerRevision: used.evidence.ownerRevision,
        ownerRootRef: '1262:price-root',
        predicateRef: '1262:price-predicate',
        verificationRef: '1262:price-proof',
      },
      factProofs: [
        {
          factRef: used.priceRef.resourceId,
          factRevisionRef: used.priceRevision.revisionId,
          verificationRef: '1262:price-proof',
        },
      ],
      lookupEvidence: used.evidence,
    });
    const support = unit.exactPrice.currencySupport;
    const scope = {
      ownerModuleId: 'commerce.pricing',
      ownerRootRef: support.supportRootRef.resourceId,
      predicateRef: support.completenessEvidence.scope.predicateRef,
      tenantId: owner.tenantId,
    };
    const temporal = {
      effectiveAt: at,
      evaluatedAt: at,
      evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
      nextMaterialBoundary: '2099-01-01T00:00:00.000Z',
      observedAt: support.observedAt,
      requestedAt,
    };
    const snapshotEvidence = yield* Schema.decodeEffect(PricingSourceEvidenceVerifiedPresentSchema)({
      _tag: 'VERIFIED_PRESENT',
      completeness: {
        completenessEvidence: support.completenessEvidence,
        currencyCode: 'CZK',
        family: 'CURRENCY_SUPPORT',
        ownerScope: scope,
        ownerSetRevisionRef: support.supportRevisionRef.resourceId,
        temporal,
        verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef: support.verificationRef },
      },
      currentFacts: support.factProofs.map((proof) => ({
        currencyCode: 'CZK',
        effectivePeriod: support.effectivePeriod,
        factRef: proof.factRef,
        factRevisionRef: proof.factRevisionRef,
        family: 'CURRENCY_SUPPORT',
        ownerScope: scope,
        temporal,
        verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef: proof.verificationRef },
      })),
      request: { currencyCode: 'CZK', effectiveAt: at, family: 'CURRENCY_SUPPORT', ownerScope: scope, requestedAt },
    });
    const attempt = (ordinal: 1 | 2) =>
      Schema.decodeEffect(PricingEvaluationAttemptSchema)({
        attemptId: `1262:attempt:${ordinal}`,
        attemptOrdinal: ordinal,
        candidateRef: '1262:whole-candidate',
        completedAt: requestedAt,
        maxAttempts: 2,
        runId: '1262:run',
        snapshot: {
          attemptId: `1262:attempt:${ordinal}`,
          calculationVersions: {
            allocationContractVersions: [],
            arithmeticProfileVersions: ['pricing-czk-arithmetic:v1'],
            publicationProfileVersions: ['pricing-czk-publication:v1'],
          },
          candidateRef: '1262:whole-candidate',
          capturedAt: requestedAt,
          decision: request.decision,
          materialBindings: [
            {
              bindingRef: '1262:currency-support',
              kind: 'CURRENCY_SUPPORT',
              meaningRef: support.supportRevisionRef.resourceId,
              sourceEvidence: snapshotEvidence,
            },
          ],
          requestedAt,
          snapshotId: `1262:snapshot:${ordinal}`,
        },
        startedAt: requestedAt,
      });
    return {
      at,
      attempt,
      lineQuantity: unit.lineQuantity,
      priceReceipt,
      purchaseContextEvidence,
      quantityBasis: unit.quantityBasis,
      request,
      requestedAt,
      snapshotEvidence,
      tierInput: unit.tierSelection.evidence.input,
      unit,
    };
  },
);

// #1262 accepts true client/provider reach with an honest inability. Other owner
// prerequisites are explicit TEST values; this does not certify their producers or PRICE_RESOLVED.
const exerciseRealCatalogConsumer1262 = Effect.fn('CatalogConsumer1262.exercise')(
  function* exerciseRealCatalogConsumer1262(input: CatalogConsumer1262Input) {
    const setup = yield* catalogConsumerPreconditions1262(input);
    const { at, purchaseContextEvidence, request, requestedAt, unit } = setup;
    const owner = { legalEntityId: input.legalEntityId, now: DateTime.makeUnsafe(at), tenantId: input.tenantId };
    const ordinals: number[] = [];
    const retainedInputs: Parameters<CurrentPricingDecisionExternalOwnerEvidencePort['loadFresh']>[0][] = [];
    const failures: { readonly kind: string; readonly ownerRefs: readonly string[] }[] = [];
    const responses: { readonly path: string; readonly status: number }[] = [];
    const catalogComplete = yield* Deferred.make<boolean>();
    // The published generated client owns its HttpClient layer; its supported Fetch reference
    // observes genuine native responses without replacing the receiving pipeline.
    const baseFetch = yield* FetchHttpClient.Fetch;
    const completeCatalog = () => Deferred.doneUnsafe(catalogComplete, Effect.succeed(true));
    const observeBody = (response: Response, url: URL, body: typeof Schema.Json.Type) => {
      responses.push({ path: url.pathname, status: response.status });
      if (url.pathname === '/reads/pricing-purpose-equivalence' && response.status === 200) {
        const actual = Schema.decodeUnknownSync(PricingPurposeEquivalenceResponseSchema)(body);
        assert('assessments' in actual);
        expect(actual.assessments.map(({ handoff }) => handoff.selection)).toEqual([
          input.handoff.selection,
          input.handoff.selection,
        ]);
        if (actual.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED') {
          completeCatalog();
        }
      } else if (url.pathname === '/reads/quantity-basis-compatibility' && response.status === 200) {
        const actual = Schema.decodeUnknownSync(QuantityBasisCompatibilityResponseSchema)(body);
        expect(actual).toMatchObject({ outcome: 'NO_CONVERSION_REQUIRED', selection: input.handoff.selection });
        completeCatalog();
      } else {
        completeCatalog();
      }
    };
    const observeResponse = (response: Response) => {
      const url = new URL(response.url);
      if (url.origin !== input.endpoint.baseUrl.origin) {
        return response;
      }
      const cloned = response.clone();
      return cloned.json().then((body: typeof Schema.Json.Type) => {
        observeBody(response, url, body);
        return response;
      });
    };
    const failCatalog = (failure: Error): never => {
      completeCatalog();
      throw failure;
    };
    const observedFetch: typeof globalThis.fetch = (...args) =>
      baseFetch(...args)
        .then(observeResponse)
        .then(undefined, failCatalog);
    let credentialIndex = 0;
    const catalogIssuer = {
      issue: (requested: Parameters<CatalogSelectionGatewayCredentialIssuer['issue']>[0]) =>
        Effect.sync(() => {
          expect(requested).toEqual({
            audience: 'catalog',
            compositionRevision: input.endpoint.compositionRevision,
            legalEntityId: input.legalEntityId,
            requestCorrelation: input.correlation,
          });
          const credential = input.credentials[credentialIndex];
          credentialIndex += 1;
          assert(credential !== undefined);
          return { baseUrl: input.endpoint.baseUrl, credential };
        }),
    };
    // Await the actual Catalog response before demonstrating another owner's inability,
    // so parallel fail-fast cannot turn an unperformed Catalog request into a passing test.
    const unavailableMarket = {
      issue: () =>
        Deferred.await(catalogComplete).pipe(
          Effect.andThen(
            Effect.fail(
              new PricingCommercialContextUnavailable({
                code: 'pricing_commercial_context_unavailable',
                reason: 'Explicit non-Catalog owner prerequisite is unavailable in #1262',
                retryable: true,
              }),
            ),
          ),
        ),
    };
    const validation = makePricingExternalOwnerEvidenceValidationService();
    const compositionContext = yield* Layer.build(
      makeActiveApplicationCompositionLayer(Effect.succeed(input.composition)),
    );
    const live = yield* currentPricingDecisionExternalOwnerEvidencePortFromEnvironment({
      compositionRevision: input.endpoint.compositionRevision,
      legalEntityId: input.legalEntityId,
      requestCorrelation: input.correlation,
      tenantId: input.tenantId,
    }).pipe(
      Effect.provideService(CatalogSelectionGatewayCredentialService, catalogIssuer),
      Effect.provideService(CommercialContextGatewayCredentialService, unavailableMarket),
      Effect.provideService(PricingExternalOwnerEvidenceValidation, validation),
      Effect.provideContext(compositionContext),
    );
    const composition = makeCurrentPricingDecisionWholeComposition();
    const { line } = unit;
    const feeTarget = { variantRef: line.catalog.selection.variantRef };
    const feePredicate = pricingCommercialFeeCurrentSetPredicateRef({
      commercialScope: request.decision.commercialScope,
      currencyCode: 'CZK',
      target: feeTarget,
    });
    const feeAuthority = yield* Schema.decodeEffect(CommercialFeeSetAuthoritySchema)({
      generation: 1,
      observedAt: requestedAt,
      ownerRevision: '1262:fee-set',
      ownerRootRef: '1262:fee-root',
      predicateRef: feePredicate,
      verificationRef: '1262:fee-proof',
    });
    const feeSet = {
      commercialScope: request.decision.commercialScope,
      completenessEvidence: {
        observedAt: requestedAt,
        ownerRevision: feeAuthority.ownerRevision,
        scope: { kind: 'EXACT_PREDICATE', predicateRef: feePredicate },
      },
      currencyCode: 'CZK',
      currentnessEvidence: {
        observedAt: requestedAt,
        ownerRevision: feeAuthority.ownerRevision,
        predicateRef: feePredicate,
        revalidatedAt: requestedAt,
        verificationMode: 'OWNER_CURRENT_SET_REVALIDATED',
      },
      fees: [],
      observedAt: requestedAt,
      target: feeTarget,
    };
    const recordFailure = (failure: { readonly kind: string; readonly ownerRefs: readonly string[] }) =>
      Effect.sync(() => {
        failures.push({ kind: failure.kind, ownerRefs: failure.ownerRefs });
      });
    const service = makeCurrentPricingDecisionWholeEvaluationService({
      attemptSource: {
        loadFresh: (_request, _trusted, ordinal) =>
          Effect.gen(function* loadDeclaredUpstream() {
            ordinals.push(ordinal);
            return {
              attempt: yield* setup.attempt(ordinal).pipe(Effect.orDie),
              exactPriceLines: [
                {
                  exactPrice: unit.exactPrice,
                  exactPriceInput: {
                    currencySupport: unit.exactPrice.currencySupport,
                    resolutionInput: unit.exactPrice.path.resolutionInput,
                  },
                  exactPriceTrustedContext: {
                    legalEntityId: owner.legalEntityId,
                    tenantId: owner.tenantId,
                    trustedOperationAt: owner.now,
                  },
                  line: unit.line,
                  lineQuantity: setup.lineQuantity,
                  priceCandidateSetAuthorities: [setup.priceReceipt],
                  quantityBasis: setup.quantityBasis,
                },
              ] as const,
              requiredOwnerRefs: ['commerce.market-catalog'] as const,
            };
          }),
      },
      composition,
      discountReader: { loadCurrent: () => Effect.succeed({ applicabilityInputs: [], currentSets: [] }) },
      externalOwnerEvidence: {
        loadFresh: (retainedInput) =>
          Effect.gen(function* consumeRealCatalogInput1262() {
            retainedInputs.push(retainedInput);
            expect(retainedInput.request.decision.lines.map(({ catalog }) => catalog)).toEqual([input.handoff]);
            expect(retainedInput.commercialTotal.decision).toEqual(request.decision);
            return yield* live.loadFresh(retainedInput).pipe(Effect.tapError(recordFailure));
          }),
      },
      feeReader: {
        loadCurrent: (_request, _attempt, price) =>
          Effect.gen(function* emptyFeePrecondition() {
            assert('usedPrice' in price.input.exactPrice.path);
            const authority = feeAuthority;
            const feeInput = yield* Schema.decodeUnknownEffect(PricingCommercialFeeCalculationInputSchema)({
              baseLineValue: price.baseLineValue,
              currencySupport: price.input.exactPrice.currencySupport,
              decision: request.decision,
              feeSet,
              occurrenceId: line.occurrenceId,
              pricePath: {
                priceRef: price.input.exactPrice.path.usedPrice.priceRef,
                priceRevisionId: price.input.exactPrice.path.usedPrice.priceRevision.revisionId,
                source: 'NO_GROUP_PRICE',
              },
            });
            return { authority, factProofs: [], input: feeInput };
          }).pipe(Effect.orDie),
      },
      floorReader: {
        loadCurrent: (_request, _attempt, raw) =>
          Effect.gen(function* nonnegativeFloorPrecondition() {
            const [rawLine] = raw.lines;
            assert(rawLine !== undefined);
            const prototype = authorizationSetFor(rawLine, { authorizations: [], observedAt: requestedAt });
            const authorizationSet = yield* Schema.decodeUnknownEffect(PricingZeroFloorCurrentAuthorizationSetSchema)({
              ...prototype,
              currentness: { ...prototype.currentness, evaluatedAt: at },
              query: { ...prototype.query, effectiveAt: at },
            });
            return [
              {
                authority: {
                  generation: 1,
                  observedAt: requestedAt,
                  ownerRevision: authorizationSet.ownerRevision,
                  ownerRootRef: '1262:floor-root',
                  predicateRef: authorizationSet.exactPredicateRef,
                  verificationRef: '1262:floor-proof',
                },
                authorizationSet,
                factProofs: [],
                occurrenceId: rawLine.occurrenceId,
              },
            ];
          }).pipe(Effect.orDie),
      },
      promotionEvaluation: { evaluate: () => Effect.die('No Promotion contribution was selected') },
      tierReader: {
        loadCurrent: () =>
          Effect.succeed({
            authority: setup.tierInput.tierSet.authority,
            request: { input: setup.tierInput, outcome: 'TIER_SET_CURRENT' as const },
          }),
      },
    });

    const result = yield* service
      .loadFresh(
        request,
        { purchaseContextEvidence, sellingLegalEntityId: input.legalEntityId, tenantId: input.tenantId },
        1,
      )
      .pipe(Effect.provideService(FetchHttpClient.Fetch, observedFetch));
    expect(retainedInputs).toHaveLength(1);
    expect(ordinals).toEqual([1]);
    expect(responses).toEqual([
      { path: '/reads/pricing-purpose-equivalence', status: 200 },
      { path: '/reads/quantity-basis-compatibility', status: 200 },
    ]);
    expect(credentialIndex).toBe(2);
    expect(failures).toEqual([{ kind: 'UNAVAILABLE', ownerRefs: ['commerce.market-catalog'] }]);
    expect(result.outcome).toMatchObject({
      outcome: 'PRICING_INDETERMINATE',
      reasonCode: 'OWNER_STATE_UNAVAILABLE',
      retryable: true,
    });
  },
);

const declaredMarketPrerequisite1225 = (payload: PricingCurrentMarketEvidenceRequest, nativeClock: Clock.Clock) =>
  Effect.gen(function* declaredMarketResponse1225() {
    const encodedRequest = yield* Schema.encodeEffect(PricingCurrentMarketEvidenceRequestSchema)(payload);
    const { channel, marketRef, sellingLegalEntityRef } = payload.commercialScope;
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const response = yield* Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceResponseSchema)({
      market: {
        channels: [channel],
        definitionRevisionRef: {
          ...marketRef,
          resourceId: 'TEST:1225:market-definition',
          resourceType: 'commerce.market-catalog.market-definition-revision',
        },
        effectivePeriod: { startsAt: encodedRequest.effectiveAt },
        jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
        lifecycle: 'ACTIVE',
        marketCode: 'CZ',
        marketRef,
        purpose: 'Explicit TEST non-Catalog prerequisite',
        revision: 1,
        sellingLegalEntityRef,
        supportedLocales: ['cs-CZ'],
      },
      outcome: 'PRICING_MARKET_SOURCE_PRESENT',
      receipt: {
        authority: {
          generation: 1,
          observedAt,
          ownerRootRef: 'TEST:1225:market-root',
          ownerSetRevisionRef: 'TEST:1225:market-set',
          predicateRef: 'TEST:1225:market-predicate',
          verificationRef: 'TEST:1225:market-proof',
        },
        currentFacts: [
          {
            effectivePeriod: { startsAt: encodedRequest.effectiveAt },
            factRef: marketRef.resourceId,
            factRevisionRef: 'TEST:1225:market-definition',
            verificationRef: 'TEST:1225:market-proof',
          },
        ],
        state: 'PRESENT',
      },
      request: encodedRequest,
    });
    return yield* Schema.encodeEffect(PricingCurrentMarketEvidenceResponseSchema)(response);
  }).pipe(Effect.orDie, Effect.provideService(Clock.Clock, nativeClock));

const nativeWholeCandidateComponents = (nativeClock: Clock.Clock) =>
  Effect.gen(function* actualCatalogWholeCandidateReceiver() {
    const fs = yield* FileSystem.FileSystem;
    const directory = `${appRoot}verticals/catalog/.cache/ontos-1225/`;
    yield* fs.makeDirectory(directory, { recursive: true });
    const artifact = `${directory}${yield* nextId}.mjs`;
    yield* Effect.addFinalizer(() => fs.remove(artifact, { force: true }).pipe(Effect.orDie));
    const build = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        'exec',
        'esbuild',
        'verticals/catalog/tests/support/whole-candidate-catalog-receiver.fixture.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--outfile=${artifact}`,
      ],
      { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
    );
    const [buildExit] = yield* Effect.all(
      [build.exitCode, Stream.runDrain(build.stdout), Stream.runDrain(build.stderr)],
      { concurrency: 3 },
    );
    expect(buildExit).toBe(0);
    const describe = yield* ChildProcess.make(process.execPath, [artifact, '--describe-whole-candidate'], {
      cwd: appRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [descriptionExit, descriptionJson] = yield* Effect.all(
      [describe.exitCode, describe.stdout.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(describe.stderr)],
      { concurrency: 3 },
    );
    expect(descriptionExit).toBe(0);
    const description = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(WholeCandidateCatalogDescriptionSchema),
    )(descriptionJson.trim());
    expect(description.actionKeys).toEqual(catalogActionKeys);
    const composition = yield* makeApplicationCompositionSnapshotFixture(['catalog', 'pricing'], {
      catalog: description.buildMarker,
      pricing: ultramodernApiMarker.buildMarker,
    });
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: composition,
      mode: 'schema-only',
      purpose: 'stabilization-1225-whole-candidate',
    });
    yield* isolated.assertClonedSchema();
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        actionExecutor: 'manager-only',
        actionKeys: catalogActionKeys,
        adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
        allowedAudiences: ['catalog', 'pricing'],
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        compositionRevision: composition.composition.revision,
        moduleAccess: 'configured-modules',
        moduleKeys: ['commerce.catalog', 'commerce.pricing'],
        runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      }),
      (value) => value.close().pipe(Effect.orDie),
    );
    const runtimeIdentityMatches = yield* fixture.prepareOwner(
      (_transaction, scope) =>
        Effect.succeed(scope.tenantId === fixture.tenantId && scope.principalId === fixture.manager.principalId),
      'forbidden',
    );
    expect(runtimeIdentityMatches).toBe(true);
    const permissions = yield* makeContextPermissionRelationshipMutationLive();
    const principal = { principalId: fixture.manager.principalId, tenantId: fixture.tenantId };
    const targets = [
      { moduleId: 'commerce.pricing', permission: componentPermission },
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.quantity-preparation' },
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.pricing-purpose-equivalence' },
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.quantity-basis-compatibility' },
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.media' },
    ];
    for (const target of targets) {
      yield* permissions.mutate({
        legalEntityId: fixture.legalEntityId,
        operation: 'grant',
        principal,
        target,
        tenantId: fixture.tenantId,
      });
      yield* Effect.addFinalizer(() =>
        permissions
          .mutate({
            legalEntityId: fixture.legalEntityId,
            operation: 'revoke',
            principal,
            target,
            tenantId: fixture.tenantId,
          })
          .pipe(Effect.orDie),
      );
    }
    const keys = yield* Effect.tryPromise({
      catch: () => unavailable('signing-key'),
      try: () => globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
    });
    assert('privateKey' in keys);
    const publicKey = yield* Effect.tryPromise({
      catch: () => unavailable('public-key'),
      try: () => globalThis.crypto.subtle.exportKey('jwk', keys.publicKey),
    });
    const kid = 'whole-candidate-native';
    const issuer = 'https://whole-candidate-native.ontos.test';
    const publicJwkSchema = Schema.Struct({
      crv: Schema.Literal('Ed25519'),
      kty: Schema.Literal('OKP'),
      x: Schema.String,
    });
    const jwksSchema = Schema.Struct({
      keys: Schema.Array(
        Schema.Struct({
          ...publicJwkSchema.fields,
          alg: Schema.Literal('EdDSA'),
          kid: Schema.String,
          use: Schema.Literal('sig'),
        }),
      ),
    });
    const publicJwk = yield* Schema.decodeUnknownEffect(publicJwkSchema)(publicKey);
    const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(jwksSchema))({
      keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }],
    });
    const commands = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const protocolResponses = yield* Queue.unbounded<typeof WholeCandidateCatalogResponseSchema.Type>();
    const protocolFailure = yield* Deferred.make<never, WholeCandidateReceiverTestUnavailable>();
    const child = yield* ChildProcess.make(process.execPath, [artifact, '--serve-whole-candidate'], {
      additionalFds: { fd3: { type: 'output' }, fd4: { stream: Stream.fromQueue(commands), type: 'input' } },
      cwd: appRoot,
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    yield* Effect.addFinalizer(() => Queue.end(commands));
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
    yield* Stream.runDrain(child.stdout).pipe(Effect.forkScoped);
    yield* child.getOutputFd(3).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(WholeCandidateCatalogResponseSchema), {
          onExcessProperty: 'error',
        })(line),
      ),
      Stream.runForEach((response) => Queue.offer(protocolResponses, response)),
      Effect.catchCause(() => Deferred.fail(protocolFailure, unavailable('child-response-codec-or-stream-failed'))),
      Effect.forkScoped,
    );
    const send = (command: typeof WholeCandidateCatalogCommandSchema.Type) =>
      Schema.encodeEffect(Schema.fromJsonString(WholeCandidateCatalogCommandSchema))(command).pipe(
        Effect.flatMap((line) => Queue.offer(commands, new TextEncoder().encode(`${line}\n`))),
      );
    const receive = () =>
      Effect.raceFirst(
        Effect.raceFirst(Queue.take(protocolResponses), Deferred.await(protocolFailure)),
        child.exitCode.pipe(Effect.flatMap(() => Effect.fail(unavailable('child-exited-before-response')))),
      ).pipe(
        Effect.flatMap((response) =>
          response.type === 'failed'
            ? Effect.fail(unavailable(`catalog-child:${response.reasonCode}:${response.stage}`))
            : Effect.succeed(response),
        ),
      );
    yield* send({
      actor: fixture.manager,
      composition,
      databaseName: isolated.connections.runtime.database,
      issuer,
      jwks,
      legalEntityId: WholeCandidateCatalogProducedSchema.fields.legalEntityId.make(fixture.legalEntityId),
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      scheduledConfiguration: true,
      type: 'bootstrap',
      version,
    });
    const produced = yield* Schema.decodeUnknownEffect(WholeCandidateCatalogProducedSchema)(yield* receive());
    expect(produced.actor).toEqual(fixture.manager);
    const [p1, p2, q1] = produced.selections;
    for (const resource of [p1.productRef, q1.productRef, p1.variantRef]) {
      yield* fixture.grantResourceAccess(resource, fixture.manager.principalId);
      yield* Effect.addFinalizer(() =>
        fixture.revokeResourceAccess(resource, fixture.manager.principalId).pipe(Effect.orDie),
      );
    }
    const authorization = (issuedAt: DateTime.Utc) =>
      issueCatalogAuthorization({
        actor: { ...fixture.manager, legalEntityId: fixture.legalEntityId },
        buildMarker: produced.buildMarker,
        compositionRevision: composition.composition.revision,
        issuedAt,
        issuer,
        kid,
        privateKey: keys.privateKey,
      });
    yield* send({
      authorizations: [
        Redacted.make(yield* authorization(yield* DateTime.now)),
        Redacted.make(yield* authorization(yield* DateTime.now)),
        Redacted.make(yield* authorization(yield* DateTime.now)),
      ],
      type: 'prepare',
      version,
    });
    const ready = yield* Schema.decodeUnknownEffect(WholeCandidateCatalogReadySchema)(yield* receive());
    const [handoffP1, handoffP2, handoffQ1] = ready.handoffs;
    expect(ready.handoffs.map((handoff) => handoff.status)).toEqual(['READY', 'READY', 'READY']);
    expect(ready.handoffs.map((handoff) => handoff.selection)).toEqual([p1, p2, q1]);
    const endpoint = {
      baseUrl: new URL(`http://127.0.0.1:${ready.port}`),
      compositionRevision: ready.compositionRevision,
    };

    // These are actual Catalog-issued handoffs. No receipt, validity time or owner
    // generation below is manufactured by the Pricing fixture.
    const operationTime = DateTime.formatIso(yield* DateTime.now);
    yield* fixture.prepareOwner(
      Effect.fn('WholeCandidate.establishCurrency')(function* establishCurrency(transaction, scope) {
        const currency = yield* currencySupportPersistenceForScope(
          transaction,
          scope,
          composition.composition.revision,
        );
        const payload = yield* Schema.decodeUnknownEffect(SetSupportedCurrenciesV2PayloadSchema)({
          expectedState: { state: 'ABSENT' },
          intendedEffectivePeriod: { effectiveFrom: operationTime, effectiveTo: null },
          intent: 'ESTABLISH_CURRENT',
          reason: 'Pricing native component setup',
          schemaVersion: '2',
          supportedCurrencies: ['CZK'],
        });
        expect(
          yield* currency.setCurrent({
            ...payload,
            actingPrincipalId: scope.principalId,
            actionInvocationId: yield* nextId,
            tenantId: scope.tenantId,
            trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
          }),
        ).toMatchObject({ outcome: 'CREATED' });
      }),
    );
    const priceComponents = yield* fixture.prepareOwner(
      (transaction, scope) => produceNativeComponents(transaction, scope, ready.handoffs, operationTime),
      'required',
    );
    const readContext = yield* Layer.build(
      nativeReadRuntime(isolated.connections.runtime.connectionString, composition),
    );
    const runtime = Context.get(readContext, ReadRuntime);
    const readTier = Effect.fn('WholeCandidate.readTierThroughCore')(function* readTier(
      component: (typeof priceComponents)[number],
      quantity: string,
    ) {
      const input = yield* Schema.decodeUnknownEffect(ComponentReadInputSchema)({
        ...component,
        effectiveAt: operationTime,
        quantity,
      });
      const result = yield* runtime
        .runRead({
          input,
          principal: { ...fixture.manager, legalEntityId: fixture.legalEntityId },
          registration: componentRead,
          transport: { correlationId: yield* nextId },
        })
        .pipe(
          Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(composition) }),
          Effect.provideContext(readContext),
        );
      return yield* Schema.decodeUnknownEffect(Schema.toType(QuantityTierSelectionResultSchema))(result);
    });
    const nativeBases = new Map<string, (typeof PriceIdentityKeySchema.Type)['unitBasis']>();
    for (const component of priceComponents) {
      const nativeSingleton = yield* readTier(component, '1');
      expect(nativeSingleton).toMatchObject({
        outcome: 'BASE_PRICE_RETAINED',
        resultingUnitPrice: { amount: '100.000000000', currencyCode: 'CZK' },
      });
      assert(nativeSingleton.outcome === 'BASE_PRICE_RETAINED');
      nativeBases.set(
        component.handoff.selection.variantRef.resourceId,
        nativeSingleton.evidence.input.attempt.exactPrice.price.definition.identityKey.unitBasis,
      );
    }
    const singleton = (handoff: typeof CatalogQuantityHandoffReadySchema.Type, occurrenceId: string) =>
      Schema.decodeUnknownEffect(PricingPurposeEquivalenceRequestSchema)({
        anchorSelection: handoff.selection,
        effectiveAt: operationTime,
        members: [{ handoff, occurrenceId }],
      });
    const originalOccurrences = [
      { handoff: handoffP1, occurrenceId: 'P-first' },
      { handoff: handoffQ1, occurrenceId: 'Q-first' },
      { handoff: handoffP1, occurrenceId: 'P-second' },
    ];
    const questions = yield* Effect.forEach(
      originalOccurrences,
      ({ handoff, occurrenceId }) => singleton(handoff, occurrenceId),
      { concurrency: 1 },
    );
    expect(questions.map((question) => question.members.map(({ occurrenceId }) => occurrenceId))).toEqual([
      ['P-first'],
      ['Q-first'],
      ['P-second'],
    ]);
    const responses = yield* Effect.forEach(
      questions,
      (question) =>
        Effect.gen(function* askActualSingleton() {
          return yield* executePricingPurposeEquivalenceWithAuthorization(
            question,
            yield* authorization(yield* DateTime.now),
            yield* nextId,
            endpoint,
          );
        }),
      { concurrency: 1 },
    );
    // This is intentionally strict. Production owner validity/generation must be
    // repaired before native allocation; UNVERIFIABLE cannot pass as CONFIRMED.
    expect(responses.map(({ outcome }) => outcome)).toEqual([
      'CATALOG_EQUIVALENCE_CONFIRMED',
      'CATALOG_EQUIVALENCE_CONFIRMED',
      'CATALOG_EQUIVALENCE_CONFIRMED',
    ]);
    for (let index = 0; index < questions.length; index += 1) {
      const response = responses[index];
      const question = questions[index];
      if (response?.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED' || question === undefined) {
        return yield* unavailable('strict-singleton-owner-proof');
      }
      expect(response.evidence.members.map(({ occurrenceId }) => occurrenceId)).toEqual(
        question.members.map(({ occurrenceId }) => occurrenceId),
      );
      const replay = yield* executePricingPurposeEquivalenceWithAuthorization(
        question,
        yield* authorization(yield* DateTime.now),
        yield* nextId,
        endpoint,
      );
      expect(replay.outcome).toBe('CATALOG_EQUIVALENCE_CONFIRMED');
      if (replay.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED') {
        return yield* unavailable('strict-unchanged-owner-replay');
      }
      expect(replay.generation).toBe(response.generation);
      // Fresh reads retain material identity while issuing their own observation receipt.
      expect(replay.verificationReceipt.issuedAt >= response.verificationReceipt.issuedAt).toBe(true);
      expect(replay.currentness.validThrough).toBe(response.currentness.validThrough);
      expect(replay.verificationReceipt.ownerRevision).toBe(response.verificationReceipt.ownerRevision);
      expect(replay.verificationReceipt.predicate).toEqual(response.verificationReceipt.predicate);
    }
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(PricingPurposeEquivalenceRequestSchema)({
          anchorSelection: p1,
          effectiveAt: operationTime,
          members: [
            { handoff: handoffP1, occurrenceId: 'P' },
            { handoff: handoffQ1, occurrenceId: 'Q' },
          ],
        }),
      ),
    ).toBe(true);
    const sameProductSeparate = yield* Effect.forEach(
      [handoffP1, handoffP2],
      (handoff, index) =>
        Effect.gen(function* separateVariant() {
          const question = yield* singleton(handoff, `P-variant-${index}`);
          return yield* executePricingPurposeEquivalenceWithAuthorization(
            question,
            yield* authorization(yield* DateTime.now),
            yield* nextId,
            endpoint,
          );
        }),
      { concurrency: 1 },
    );
    expect(sameProductSeparate.map(({ outcome }) => outcome)).toEqual([
      'CATALOG_EQUIVALENCE_CONFIRMED',
      'CATALOG_EQUIVALENCE_CONFIRMED',
    ]);
    const nonEquivalent = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceRequestSchema)({
      anchorSelection: p1,
      effectiveAt: operationTime,
      members: [
        { handoff: handoffP1, occurrenceId: 'P1' },
        { handoff: handoffP2, occurrenceId: 'P2' },
      ],
    });
    const nonEquivalentResponse = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceResponseSchema)(
      yield* executePricingPurposeEquivalenceWithAuthorization(
        nonEquivalent,
        yield* authorization(yield* DateTime.now),
        yield* nextId,
        endpoint,
      ),
    );
    expect(nonEquivalentResponse).toMatchObject({
      currentness: { effectiveAt: nonEquivalent.effectiveAt, status: 'CURRENT' },
      outcome: 'CATALOG_EQUIVALENCE_NON_EQUIVALENT',
      reason: 'The exact selections do not share one Catalog-owner Pricing-purpose meaning',
    });
    if (nonEquivalentResponse.outcome !== 'CATALOG_EQUIVALENCE_NON_EQUIVALENT') {
      return yield* unavailable('strict-distinct-variant-non-equivalence');
    }
    expect(
      nonEquivalentResponse.assessments.map((assessment) =>
        assessment.role === 'ANCHOR'
          ? { role: assessment.role, selection: assessment.handoff.selection }
          : { occurrenceId: assessment.occurrenceId, role: assessment.role, selection: assessment.handoff.selection },
      ),
    ).toEqual([
      { role: 'ANCHOR', selection: p1 },
      { occurrenceId: 'P1', role: 'MEMBER', selection: p1 },
      { occurrenceId: 'P2', role: 'MEMBER', selection: p2 },
    ]);
    expect(nonEquivalentResponse.assessments.map(({ handoff }) => handoff.equivalentSelectionKey)).toEqual([
      handoffP1.equivalentSelectionKey,
      handoffP1.equivalentSelectionKey,
      handoffP2.equivalentSelectionKey,
    ]);
    expect(handoffP1.equivalentSelectionKey).not.toBe(handoffP2.equivalentSelectionKey);
    const equal = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceRequestSchema)({
      anchorSelection: p1,
      effectiveAt: operationTime,
      members: [
        { handoff: handoffP1, occurrenceId: 'P1-first' },
        { handoff: handoffP1, occurrenceId: 'P1-second' },
      ],
    });
    const equalProof = yield* executePricingPurposeEquivalenceWithAuthorization(
      equal,
      yield* authorization(yield* DateTime.now),
      yield* nextId,
      endpoint,
    );
    expect(equalProof.outcome).toBe('CATALOG_EQUIVALENCE_CONFIRMED');
    if (equalProof.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED') {
      return yield* unavailable('true-owner-equivalence-required-before-component-pooling');
    }
    const [firstPrice] = priceComponents;
    if (firstPrice === undefined) {
      return yield* unavailable('native-price-absent');
    }
    const normalized = {
      quantity: handoffP1.quantity.resulting,
      quantityBasis: {
        catalogQuantityBasis: handoffP1.quantityBasis,
        priceUnitBasis: { quantity: '1', unitRef: handoffP1.unitRef },
      },
    };
    const pooled = sumQuantityTierNormalizedQuantities([
      yield* Schema.decodeUnknownEffect(QuantityTierNormalizedQuantitySchema)(normalized),
      yield* Schema.decodeUnknownEffect(QuantityTierNormalizedQuantitySchema)(normalized),
    ]);
    expect(pooled?.quantity).toBe('2');
    if (pooled === undefined) {
      return yield* unavailable('exact-quantity-basis-pooling');
    }
    expect(yield* readTier(firstPrice, pooled.quantity)).toMatchObject({
      outcome: 'QUANTITY_TIER_APPLIED',
      resultingUnitPrice: { amount: '75.000000000', currencyCode: 'CZK' },
    });
    const issuerCrypto1225 = yield* Crypto.Crypto;
    const issuer1225: CatalogSelectionGatewayCredentialIssuer = {
      issue: () =>
        Effect.gen(function* issueActualCatalogAssertion1225() {
          return { ...endpoint, credential: Redacted.make(yield* authorization(yield* DateTime.now)) };
        }).pipe(
          Effect.orDie,
          Effect.provideService(Clock.Clock, nativeClock),
          Effect.provideService(Crypto.Crypto, issuerCrypto1225),
        ),
    };
    const live1225 = makeCurrentPricingDecisionExternalOwnerEvidenceLivePort(
      {
        compositionRevision: composition.composition.revision,
        legalEntityId: fixture.legalEntityId,
        requestCorrelation: 'TEST:1225:joined',
        tenantId: fixture.tenantId,
      },
      {
        applicationComposition: { load: Effect.succeed(composition) },
        catalog: {
          execute: (payload, credential, correlation, options) =>
            executePricingPurposeEquivalenceWithAuthorization(
              payload,
              Redacted.value(credential),
              correlation,
              options,
            ),
          executeCompatibility: (payload, credential, correlation, options) =>
            executeQuantityBasisCompatibilityWithAuthorization(
              payload,
              Redacted.value(credential),
              correlation,
              options,
            ),
          issuer: issuer1225,
        },
        customerContext: {
          execute: () => Effect.die('Guest does not request Profile evidence'),
          issuer: { issue: () => Effect.die('Guest does not request Profile credentials') },
        },
        market: {
          execute: (payload) => declaredMarketPrerequisite1225(payload, nativeClock),
          issuer: {
            issue: () =>
              Effect.succeed({
                baseUrl: new URL('http://127.0.0.1:1225'),
                credential: Redacted.make('TEST:1225:declared-market-prerequisite'),
              }),
          },
        },
        validation: makePricingExternalOwnerEvidenceValidationService(),
      },
    );
    const staleCatalogChecks: Effect.Effect<void, WholeCandidateReceiverTestUnavailable>[] = [];
    let retainedJoined:
      | {
          readonly purchaseContextEvidence: typeof PricingPurchaseContextVerificationEvidenceSchema.Type;
          readonly request: typeof CurrentPricingDecisionRequestSchema.Type;
        }
      | undefined;
    for (const scenario of [
      {
        expectedTotal: '249',
        name: 'heterogeneous-with-legitimate-pooling',
        occurrences: originalOccurrences,
        tierOutcomes: ['QUANTITY_TIER_APPLIED', 'BASE_PRICE_RETAINED', 'QUANTITY_TIER_APPLIED'],
      },
      {
        expectedTotal: '196',
        name: 'same-product-non-equivalent',
        occurrences: [
          { handoff: handoffP1, occurrenceId: 'P-variant-first' },
          { handoff: handoffP2, occurrenceId: 'P-variant-second' },
        ],
        tierOutcomes: ['BASE_PRICE_RETAINED', 'BASE_PRICE_RETAINED'],
      },
    ]) {
      const subject = {
        guestEvidenceRef: 'TEST:1225:guest-evidence',
        guestSessionRef: 'TEST:1225:guest-session',
        kind: 'GUEST' as const,
      };
      const request = yield* Schema.decodeUnknownEffect(CurrentPricingDecisionRequestSchema)({
        decision: {
          commercialScope: {
            channelId: 'B2C',
            marketId: 'component-test',
            sellingLegalEntityId: fixture.legalEntityId,
          },
          currencyCode: 'CZK',
          lines: scenario.occurrences.map(({ handoff, occurrenceId }) => ({
            catalog: handoff,
            occurrenceId,
            pricingBasis: nativeBases.get(handoff.selection.variantRef.resourceId),
          })),
          monetaryBoundary: 'PRE_TAX',
          operationTime,
          purchasingContext: {
            accessDecision: { decisionRef: 'TEST:1225:access', decisionRevision: '1' },
            actor: subject,
            commercialSettingsDecision: { decisionRef: 'TEST:1225:commercial-settings', decisionRevision: '1' },
            contextRef: 'TEST:1225:declared-purchase-context',
            contextRevision: '1',
            currencyResolution: { currencyCode: 'CZK', resolutionRef: 'TEST:1225:currency', resolutionRevision: '1' },
            subject,
          },
          tenantId: fixture.tenantId,
        },
        subject,
      });
      const purchaseContextEvidence = yield* Schema.decodeUnknownEffect(
        PricingPurchaseContextVerificationEvidenceSchema,
      )({
        currentness: { evaluatedAt: operationTime, observedAt: operationTime, validFrom: operationTime, validTo: null },
        ownerRef: request.decision.purchasingContext.contextRef,
        ownerRevisionRef: request.decision.purchasingContext.contextRevision,
        subjectAuthority: {
          guestEvidenceAuthorityRef: 'TEST:1225:declared-guest-authority',
          guestSessionAuthorityRef: 'TEST:1225:declared-session-authority',
          kind: 'GUEST',
          subject,
          subjectAuthorityRevisionRef: '1',
        },
        verificationRef: 'TEST:1225:declared-purchase-verification',
        verifiedScope: {
          channelId: 'B2C',
          legalEntityId: fixture.legalEntityId,
          marketId: 'component-test',
          tenantId: fixture.tenantId,
        },
      });
      retainedJoined ??= { purchaseContextEvidence, request };
      const observed: JoinedObservation1225[] = [];
      const result = yield* runtime
        .runRead({
          input: { ...firstPrice, effectiveAt: operationTime, quantity: '1', wholeRequest: request },
          principal: { ...fixture.manager, legalEntityId: fixture.legalEntityId },
          registration: componentRead,
          transport: { correlationId: yield* nextId },
        })
        .pipe(
          Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(composition) }),
          Effect.provideService(JoinedPrerequisites1225, {
            catalogIssuer: issuer1225,
            external: live1225,
            observe: (value) => {
              observed.push(value);
            },
            purchaseContextEvidence,
          }),
          Effect.provideContext(readContext),
        );
      const total = yield* Schema.decodeUnknownEffect(Schema.toType(PricingCommercialTotalReadySchema))(result);
      expect(total.pricingNetCommercialTotal).toEqual({ amount: scenario.expectedTotal, currencyCode: 'CZK' });
      expect(
        total.sourceEvidence.preRound.rawComposition.lines.map(
          ({ unitPriceCalculation }) => unitPriceCalculation.input.tierSelection.outcome,
        ),
      ).toEqual(scenario.tierOutcomes);
      expect(total.breakdown.commercialFeeTotal).toEqual({
        amount: String(scenario.occurrences.length * 3),
        currencyCode: 'CZK',
      });
      expect(total.publishedLines.map(({ occurrenceId }) => occurrenceId)).toEqual(
        scenario.occurrences.map(({ occurrenceId }) => occurrenceId),
      );
      expect(observed).toHaveLength(1);
      const [actual] = observed;
      assert(actual !== undefined);
      expect(actual.externalOwnerEvidence.retained.catalogSelections.map(({ occurrenceId }) => occurrenceId)).toEqual(
        scenario.occurrences.map(({ occurrenceId }) => occurrenceId),
      );
      expect(
        actual.externalOwnerEvidence.fenceSources.filter(
          ({ verificationMaterial }) => verificationMaterial.kind === 'CATALOG_EQUIVALENCE_AUTHORITY',
        ),
      ).toHaveLength(scenario.occurrences.length);
      expect(total.sourceEvidence.preRound.rawComposition.wholePurchaseAllocationEvidence?.request).toMatchObject({
        allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL',
        originalContribution: { amount: '-10', currencyCode: 'CZK' },
      });
      const typedSources = actual.externalOwnerEvidence.fenceSources
        .filter(Schema.is(PricingSetBackedMaterialEvidenceFenceSourceSchema))
        .filter(
          ({ verificationMaterial }) =>
            verificationMaterial.kind === 'CATALOG_LINE_AUTHORITY' ||
            verificationMaterial.kind === 'CATALOG_EQUIVALENCE_AUTHORITY',
        );
      expect(typedSources).toHaveLength(scenario.occurrences.length * 2);
      const sources = typedSources.map(({ sourceEvidence }) => {
        const { completeness } = sourceEvidence;
        return {
          currentFacts: Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(sourceEvidence)
            ? sourceEvidence.currentFacts.map(({ factRef, factRevisionRef, verification }) => ({
                factRef,
                factRevisionRef,
                verificationRef: verification.verificationRef,
              }))
            : [],
          evidenceObservedAt: completeness.temporal.observedAt,
          evidenceVerificationRef: completeness.verification.verificationRef,
          family: completeness.family,
          ownerModuleId: completeness.ownerScope.ownerModuleId,
          ownerRootRef: completeness.ownerScope.ownerRootRef,
          ownerSetRevisionRef: completeness.ownerSetRevisionRef,
          predicateRef: completeness.ownerScope.predicateRef,
          tenantId: completeness.ownerScope.tenantId,
        };
      });
      const candidateRef = `TEST:1225:${scenario.name}`;
      const verificationContext = {
        candidateRef,
        decision: request.decision,
        effectiveAt: operationTime,
        evaluatedAt: DateTime.formatIso(yield* DateTime.now),
        requestedAt: operationTime,
        subject: request.subject,
      };
      const gateway = makePricingCurrentDecisionCatalogOwnerFinalFenceGateway({
        equivalence: (payload, credential, correlation, options) =>
          executePricingPurposeEquivalenceWithAuthorization(payload, Redacted.value(credential), correlation, options),
        issuer: issuer1225,
        quantity: (payload, credential, correlation, options) =>
          executeQuantityBasisCompatibilityWithAuthorization(payload, Redacted.value(credential), correlation, options),
      });
      const retainedPhaseInput = {
        candidateRef,
        compositionRevision: composition.composition.revision,
        sources,
        typedSources,
        verificationContext,
      };
      const phaseOne = yield* gateway.verifyOpaqueProofsAgainstCurrentState(retainedPhaseInput);
      staleCatalogChecks.push(
        gateway.verifyOpaqueProofsAgainstCurrentState(retainedPhaseInput).pipe(
          Effect.flip,
          Effect.tap((failure) =>
            Effect.sync(() => {
              expect(Schema.is(PricingOwnerMaterialEvidenceFenceGatewayUnavailable)(failure)).toBe(true);
            }),
          ),
          Effect.asVoid,
          Effect.mapError(() => unavailable('mutated-catalog-phase-one-unexpected-success')),
        ),
        gateway
          .confirmObservedGenerationsThrough({
            candidateRef,
            compositionRevision: composition.composition.revision,
            observations: phaseOne.observations,
            through: phaseOne.completedAt,
            typedSources,
            verificationContext,
          })
          .pipe(
            Effect.flip,
            Effect.tap((failure) =>
              Effect.sync(() => {
                expect(Schema.is(PricingOwnerMaterialEvidenceFenceGatewayUnavailable)(failure)).toBe(true);
              }),
            ),
            Effect.asVoid,
            Effect.mapError(() => unavailable('mutated-catalog-phase-two-unexpected-success')),
          ),
      );
      expect(phaseOne.observations.map(({ evidenceVerificationRef }) => evidenceVerificationRef)).toEqual(
        sources.map(({ evidenceVerificationRef }) => evidenceVerificationRef),
      );
      const phaseTwo = yield* gateway.confirmObservedGenerationsThrough({
        candidateRef,
        compositionRevision: composition.composition.revision,
        observations: phaseOne.observations,
        through: phaseOne.completedAt,
        typedSources,
        verificationContext,
      });
      expect(phaseTwo.confirmations.map(({ evidenceVerificationRef }) => evidenceVerificationRef)).toEqual(
        sources.map(({ evidenceVerificationRef }) => evidenceVerificationRef),
      );
      expect(
        phaseTwo.confirmations.map(({ currentInvalidationGenerationRef }) => currentInvalidationGenerationRef),
      ).toEqual(phaseOne.observations.map(({ currentInvalidationGenerationRef }) => currentInvalidationGenerationRef));
    }

    const compatibility = yield* executeQuantityBasisCompatibilityWithAuthorization(
      {
        effectiveAt: handoffP1.evidence.assessedAt,
        handoff: handoffP1,
        price: { quantity: '1', quantityBasis: handoffP1.quantityBasis },
      },
      yield* authorization(yield* DateTime.now),
      yield* nextId,
      endpoint,
    );
    expect(compatibility.outcome).toBe('NO_CONVERSION_REQUIRED');
    yield* exerciseRealCatalogConsumer1262({
      compatibility,
      composition,
      correlation: yield* nextId,
      credentials: [
        Redacted.make(yield* authorization(yield* DateTime.now)),
        Redacted.make(yield* authorization(yield* DateTime.now)),
      ],
      endpoint,
      handoff: handoffP1,
      legalEntityId: fixture.legalEntityId,
      principalId: fixture.manager.principalId,
      tenantId: fixture.tenantId,
    });
    yield* send({ expectedRevision: handoffP1.quantity.unitRuleRevision, type: 'revise-first-unit', version });
    const revised = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        ruleRevision: Schema.Int.check(Schema.isGreaterThan(0)),
        type: Schema.Literal('revised'),
        version: Schema.Literal(protocolVersion),
      }),
      { onExcessProperty: 'error' },
    )(yield* receive());
    expect(revised.ruleRevision).toBeGreaterThan(handoffP1.quantity.unitRuleRevision);
    yield* Effect.all(staleCatalogChecks, { concurrency: 1 });
    const stale = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceResponseSchema)(
      yield* executePricingPurposeEquivalenceWithAuthorization(
        equal,
        yield* authorization(yield* DateTime.now),
        yield* nextId,
        endpoint,
      ),
    );
    expect(stale).toMatchObject({
      currentness: { effectiveAt: equal.effectiveAt, status: 'STALE' },
      outcome: 'CATALOG_EQUIVALENCE_STALE',
      reason: 'A supplied Quantity, Unit, Package, Configuration, or Set revision is no longer Current',
    });
    if (stale.outcome !== 'CATALOG_EQUIVALENCE_STALE') {
      return yield* unavailable('strict-mutated-unit-rule-stale');
    }
    expect(
      stale.assessments.map((assessment) =>
        assessment.role === 'ANCHOR'
          ? { role: assessment.role, selection: assessment.handoff.selection }
          : { occurrenceId: assessment.occurrenceId, role: assessment.role, selection: assessment.handoff.selection },
      ),
    ).toEqual([
      { role: 'ANCHOR', selection: p1 },
      { occurrenceId: 'P1-first', role: 'MEMBER', selection: p1 },
      { occurrenceId: 'P1-second', role: 'MEMBER', selection: p1 },
    ]);
    for (const assessment of stale.assessments) {
      expect(assessment.handoff.unitRef).toEqual(handoffP1.unitRef);
      expect(assessment.handoff.quantity.unitRuleRevision).toBe(revised.ruleRevision);
      expect(assessment.handoff.quantityBasis.unitRuleRevision).toBe(revised.ruleRevision);
      expect(assessment.handoff.quantity.unitRuleRevision).not.toBe(handoffP1.quantity.unitRuleRevision);
    }
    const fresh = yield* executeQuantityPreparationWithAuthorization(
      { amount: '1', purpose: 'PRICING', selection: p1 },
      yield* authorization(yield* DateTime.now),
      yield* nextId,
      endpoint,
    );
    expect(fresh.status).toBe('READY');
    if (fresh.status !== 'READY') {
      return yield* unavailable('fresh-owner-retry-ready');
    }
    expect(fresh.selection).toEqual(p1);
    expect(fresh.unitRef).toEqual(handoffP1.unitRef);
    expect(fresh.quantity.unitRuleRevision).toBe(revised.ruleRevision);
    expect(fresh.quantityBasis.unitRuleRevision).toBe(revised.ruleRevision);
    expect(fresh.quantity.unitRuleRevision).not.toBe(handoffP1.quantity.unitRuleRevision);
    const freshQuestion = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceRequestSchema)({
      anchorSelection: fresh.selection,
      effectiveAt: fresh.evidence.assessedAt,
      members: [{ handoff: fresh, occurrenceId: 'P-fresh-retry' }],
    });
    expect(
      (yield* executePricingPurposeEquivalenceWithAuthorization(
        freshQuestion,
        yield* authorization(yield* DateTime.now),
        yield* nextId,
        endpoint,
      )).outcome,
    ).toBe('CATALOG_EQUIVALENCE_CONFIRMED');
    assert(retainedJoined !== undefined);
    const freshPricingAt = DateTime.formatIso(yield* DateTime.now);
    const freshWholeRequest = yield* Schema.decodeUnknownEffect(Schema.toType(CurrentPricingDecisionRequestSchema))({
      ...retainedJoined.request,
      decision: {
        ...retainedJoined.request.decision,
        lines: retainedJoined.request.decision.lines.map((line) =>
          line.catalog.selection.variantRef.resourceId === fresh.selection.variantRef.resourceId
            ? { ...line, catalog: fresh }
            : line,
        ),
        operationTime: freshPricingAt,
      },
    });
    const freshObserved: JoinedObservation1225[] = [];
    const freshFailure = yield* runtime
      .runRead({
        input: { ...firstPrice, effectiveAt: freshPricingAt, quantity: '1', wholeRequest: freshWholeRequest },
        principal: { ...fixture.manager, legalEntityId: fixture.legalEntityId },
        registration: componentRead,
        transport: { correlationId: yield* nextId },
      })
      .pipe(
        Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(composition) }),
        Effect.provideService(JoinedPrerequisites1225, {
          catalogIssuer: issuer1225,
          external: live1225,
          observe: (value) => {
            freshObserved.push(value);
          },
          purchaseContextEvidence: {
            ...retainedJoined.purchaseContextEvidence,
            currentness: {
              ...retainedJoined.purchaseContextEvidence.currentness,
              evaluatedAt: freshPricingAt,
              observedAt: freshPricingAt,
            },
          },
        }),
        Effect.provideContext(readContext),
        Effect.flip,
      );
    expect(Schema.is(ReadHandlerUnavailable)(freshFailure)).toBe(true);
    expect(freshObserved).toHaveLength(0);

    yield* send({ type: 'stop', version });
    yield* Queue.end(commands);
    expect(yield* child.exitCode).toBe(0);

    yield* isolated.assertClonedSchema();
    return yield* Effect.void;
  });

it.live('preserves original Catalog occurrences and native Pricing Tier components with one real Core identity', () =>
  Effect.scoped(
    Effect.gen(function* nativeWholeCandidateBoundary() {
      const nativeClock = yield* Clock.Clock;
      const context = yield* Layer.build(services);
      return yield* nativeWholeCandidateComponents(nativeClock).pipe(Effect.provideContext(context));
    }),
  ),
);
