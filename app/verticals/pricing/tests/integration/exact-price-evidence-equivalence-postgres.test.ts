import { PricingCommercialTotalSafeProjectionSchema } from '@app/pricing-contracts/domain/commercial-total';
import type { PricingMaterialEvidenceAssemblyRequest } from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingMaterialEvidenceUnverifiableFailure,
  PricingMaterialEvidenceFenceSourceSchema,
} from '@app/pricing-contracts/domain/material-evidence';
import { assemblePricingMaterialEvidence } from '../../src/services/material-evidence-assembly.service.ts';
import { PricingPurposeEquivalenceResponseSchema } from '@app/catalog/api/pricing-purpose-equivalence';
import { QuantityBasisCompatibilityResponseSchema } from '@app/catalog/api/quantity-basis-compatibility';
import { PricingCurrentMarketEvidenceResponseSchema } from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { makeCurrentPricingDecisionEvaluationService } from '../../src/services/current-pricing-decision-evaluation.service.ts';
import { publishOrdinaryCurrentPricingForCustomer } from '../../src/services/ordinary-current-pricing-publication.service.ts';
import { PricingMaterialEvidenceOwnerFinalFence } from '../../src/services/material-evidence-final-validation.service.ts';
import type {
  PricingMaterialEvidenceFenceExpectation,
  PricingMaterialEvidenceFenceSourceObservation,
} from '../../src/services/material-evidence-final-validation.service.ts';
import { makePricingMaterialEvidenceOwnerFinalFenceFromGateways } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import type { PricingOwnerMaterialEvidenceFenceGateway } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import { pricingCurrentDecisionPricingOwnerFinalFenceGatewayForScope } from '../../src/integrations/current-pricing-decision-owner-final-fence.ts';
import {
  CurrentPricingDecisionTierSetReader,
  CurrentPricingDecisionFeeSetReader,
  CurrentPricingDecisionDiscountSetReader,
  CurrentPricingDecisionZeroFloorSetReader,
  makeCurrentPricingDecisionWholeEvaluationService,
  CurrentPricingDecisionWholeComposition,
} from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import type { CurrentPricingDecisionExternalOwnerEvidencePort } from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import {
  ExactPriceLookupInvalidSchema,
  ExactPriceLookupFoundSchema,
  ExactPriceLookupUnverifiableSchema,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import {
  ExactPriceAbsentResolutionSchema,
  ExactPriceFoundResolutionSchema,
} from '@app/pricing-contracts/domain/exact-price-resolution';
import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { NodeCrypto } from '@effect/platform-node';
import { Clock, Context, Crypto, DateTime, Effect, Layer, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import {
  currentPricingDecisionWholeEvaluationAdaptersForScope,
  makeCurrentPricingDecisionAttemptSource,
} from '../../src/integrations/current-pricing-decision-whole-evaluation-adapters.ts';
import type { CurrentPricingDecisionAttemptSourcePorts } from '../../src/integrations/current-pricing-decision-whole-evaluation-adapters.ts';
import { currencySupportPersistenceForScope } from '../../src/persistence/currency-support-persistence.ts';
import {
  ExactPriceCandidateSetAuthoritySchema,
  pricePersistenceForScope,
  verifyExactPriceCandidateSetGenerationRoutine,
} from '../../src/services/price-persistence.service.ts';
import type { DefinePricePersistenceCommand } from '../../src/services/price-persistence.service.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';
import { zeroFloorAuthorizationPersistenceForScope } from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { exactPriceResolutionServiceForScope } from '../../src/services/exact-price-resolution.service.ts';
import {
  makePricingExternalOwnerEvidenceValidationService,
  PricingExternalOwnerEvidenceValidation,
} from '../../src/services/external-owner-evidence-validation.service.ts';

const definePriceGuardRoutine = defineScopedRoutine({
  name: 'define_price_v3',
  ownerModuleKey: 'commerce.pricing',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ payload: Schema.Unknown }),
  routineKey: 'pricing.define-price-v3',
  schema: 'pricing',
});

const withNativeCrypto = <Value, Failure, Requirements>(
  program: Effect.Effect<Value, Failure, Requirements | Crypto.Crypto>,
) =>
  Effect.scoped(
    Effect.gen(function* nativeCryptoBoundary() {
      const context = yield* Layer.build(NodeCrypto.layer);
      return yield* program.pipe(Effect.provideContext(context));
    }),
  );

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const operationTime = '2026-10-19T09:00:00.000Z';
const productId = '12790000-0000-4000-8000-000000000001';
const variantId = '12790000-0000-4000-8000-000000000002';
const unitId = '12790000-0000-4000-8000-000000000003';

const identityFor = (scope: OperationalScope) =>
  Schema.decodeUnknownSync(PriceIdentityKeySchema)({
    catalogSelection: {
      productRef: {
        moduleId: 'commerce.catalog',
        resourceId: productId,
        resourceType: 'commerce.catalog.product',
        tenantId: scope.tenantId,
      },
      variantRef: {
        moduleId: 'commerce.catalog',
        resourceId: variantId,
        resourceType: 'commerce.catalog.variant',
        tenantId: scope.tenantId,
      },
    },
    commercialScope: { channelId: 'B2C', marketId: 'CZ', sellingLegalEntityId: scope.legalEntityId },
    currencyCode: 'CZK',
    priceGroupSelector: { kind: 'NO_GROUP' },
    unitBasis: {
      quantity: '1.000000000',
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: unitId,
        resourceType: 'commerce.catalog.product-unit',
        tenantId: scope.tenantId,
      },
    },
  });

// Catalog readiness is an explicit precondition of #1279. This schema-only fixture does not
// claim native Catalog production or replace either Pricing producer under test.
const requestFor = (key: PriceIdentityKey, effectiveAt = operationTime) => {
  const selection = key.catalogSelection;
  const quantityBasis = {
    targetDivisibilityRevision: 1,
    targetRef: selection.variantRef,
    unitRef: key.unitBasis.unitRef,
    unitRuleRevision: 1,
  };
  const subject = {
    guestEvidenceRef: 'native-1279:guest-evidence',
    guestSessionRef: 'native-1279:guest-session',
    kind: 'GUEST' as const,
  };
  return Schema.decodeSync(CurrentPricingDecisionRequestSchema)({
    decision: {
      commercialScope: key.commercialScope,
      currencyCode: key.currencyCode,
      lines: [
        {
          catalog: {
            completeness: {
              observedAt: effectiveAt,
              ownerRevision: 'native-1279:catalog',
              scope: { kind: 'EXACT_PREDICATE', predicateRef: 'native-1279:catalog-predicate' },
            },
            divisible: true,
            equivalentSelectionKey: 'native-1279:equivalent-selection',
            evidence: {
              assessedAt: effectiveAt,
              basis: [
                { role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 1 } },
                { role: 'VARIANT', source: { resourceRef: selection.variantRef, revision: 1 } },
                {
                  provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
                  role: 'PRODUCT_TYPE_UNTYPED_DECISION',
                  source: { resourceRef: selection.productRef, revision: 1 },
                },
              ],
              membership: {
                attestationId: '12790000-0000-4000-8000-000000000004',
                observedAt: effectiveAt,
                productRef: selection.productRef,
                source: 'CATALOG_OWNER_CURRENT_READ',
                variant: { resourceRef: selection.variantRef, revision: 1 },
              },
              purpose: 'PRICING',
              selection,
              status: 'VALID',
            },
            hierarchyRevision: 'native-1279:hierarchy',
            ownerRevision: 'native-1279:catalog',
            quantity: {
              changed: false,
              notice: null,
              requested: '1',
              resulting: '1',
              rounding: 'HALF_UP',
              status: 'VALID',
              step: '1',
              targetId: variantId,
              tenantId: selection.productRef.tenantId,
              unitId,
              unitRuleRevision: 1,
            },
            quantityBasis,
            selection,
            status: 'READY',
            unitRef: key.unitBasis.unitRef,
          },
          occurrenceId: 'native-1279:line-1',
          pricingBasis: key.unitBasis,
        },
      ],
      monetaryBoundary: 'PRE_TAX',
      operationTime: effectiveAt,
      purchasingContext: {
        accessDecision: { decisionRef: 'native-1279:access', decisionRevision: '1' },
        actor: subject,
        commercialSettingsDecision: { decisionRef: 'native-1279:settings', decisionRevision: '1' },
        contextRef: 'native-1279:purchase-context',
        contextRevision: 'native-1279:context-revision',
        currencyResolution: { currencyCode: 'CZK', resolutionRef: 'native-1279:currency', resolutionRevision: '1' },
        subject,
      },
      tenantId: selection.productRef.tenantId,
    },
    subject,
  });
};

const commandFor = Effect.fn('test.nativePriceCommand')(function* commandFor(
  scope: OperationalScope,
  identityKey: PriceIdentityKey,
) {
  const actionInvocationId = yield* nextId;
  const sourceAssertionId = yield* nextId;
  const priceId = yield* nextId;
  const assertion = yield* Schema.decodeEffect(PriceSourceAssertionInputSchema)({
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'native-1279:mapping', mappingContractVersion: '1' },
    originalAssertion: {
      monetaryAmount: { amount: '100', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      unitBasis: identityKey.unitBasis,
    },
    sourceAssertionId,
    sourceAuthority: { sourceAuthorityRef: 'native-1279:owner-source', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: actionInvocationId,
      sourceRecordRef: priceId,
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'native-1279:source' },
    },
    timing: { importedAt: operationTime, ownerBusinessEffectiveAt: operationTime, sourceEffectiveAt: operationTime },
  });
  const prepared = preparePriceSourceEvidence({
    actingPrincipalId: scope.principalId,
    effectiveFrom: operationTime,
    identityKey,
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    sourceAssertion: assertion,
    tenantId: scope.tenantId,
    trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
  });
  if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
    return yield* Effect.die(new Error('Native Price source assertion must be ready'));
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
    reason: 'Verify native exact Price evidence equivalence.',
    requestCorrelationId: actionInvocationId,
    sourceEvidence: prepared.evidence,
    trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
  } satisfies DefinePricePersistenceCommand;
});

it.live(
  'binds both native readers through the whole attempt source for FOUND and virtual/persistent proven ABSENT (#1279)',
  () =>
    Effect.scoped(
      Effect.gen(function* nativePriceEvidenceEquivalence() {
        const fixture = yield* makeNativeReadTestContext({
          contextPermissions: [],
          moduleId: 'commerce.pricing',
          ownerFixtureRetention: 'retain-complete-context',
        });
        const fixtureContext = yield* Layer.build(fixture.layer);
        yield* fixture
          .prepareOwner(
            Effect.fn('test.nativePriceProducerAndConsumer')(
              function* nativePriceProducerAndConsumer(transaction, scope) {
                const key = identityFor(scope);
                const prices = yield* pricePersistenceForScope(transaction, scope);
                const currencies = yield* currencySupportPersistenceForScope(transaction, scope, 'a'.repeat(64));
                const resolver = yield* exactPriceResolutionServiceForScope(transaction, scope, 'a'.repeat(64));
                const beforeSupport = yield* prices.exactLookup({ effectiveAt: operationTime, exactKey: key });
                expect(Schema.is(ExactPriceLookupInvalidSchema)(beforeSupport)).toBe(true);
                expect(beforeSupport).toMatchObject({ reason: 'UNSUPPORTED_CURRENCY' });
                const supportPayload = yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
                  expectedState: { state: 'ABSENT' },
                  intendedEffectivePeriod: { effectiveFrom: operationTime, effectiveTo: null },
                  intent: 'ESTABLISH_CURRENT',
                  reason: 'Establish native evidence test support.',
                  schemaVersion: '2',
                  supportedCurrencies: ['CZK'],
                });
                const support = yield* currencies.setCurrent({
                  ...supportPayload,
                  actingPrincipalId: scope.principalId,
                  actionInvocationId: yield* nextId,
                  tenantId: key.catalogSelection.productRef.tenantId,
                  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
                });
                expect(support).toMatchObject({ outcome: 'CREATED' });
                const request = requestFor(key);
                const trusted = {
                  purchaseContextEvidence: yield* Schema.decodeEffect(PricingPurchaseContextVerificationEvidenceSchema)(
                    {
                      currentness: {
                        evaluatedAt: operationTime,
                        observedAt: operationTime,
                        validFrom: operationTime,
                        validTo: null,
                      },
                      ownerRef: request.decision.purchasingContext.contextRef,
                      ownerRevisionRef: request.decision.purchasingContext.contextRevision,
                      subjectAuthority: {
                        guestEvidenceAuthorityRef: 'native-1279:guest-owner',
                        guestSessionAuthorityRef: 'native-1279:session-owner',
                        kind: 'GUEST',
                        subject: {
                          guestEvidenceRef: 'native-1279:guest-evidence',
                          guestSessionRef: 'native-1279:guest-session',
                          kind: 'GUEST',
                        },
                        subjectAuthorityRevisionRef: 'native-1279:guest-revision',
                      },
                      verificationRef: 'native-1279:purchase-proof',
                      verifiedScope: {
                        channelId: 'B2C',
                        legalEntityId: key.commercialScope.sellingLegalEntityId,
                        marketId: 'CZ',
                        tenantId: scope.tenantId,
                      },
                    },
                  ),
                  sellingLegalEntityId: key.commercialScope.sellingLegalEntityId,
                  tenantId: scope.tenantId,
                };
                const sourcePorts = {
                  exactPrice: resolver,
                  interpreter: {
                    interpret: () => Effect.die(new Error('Guest Price must not read group interpretation')),
                  },
                  loadCurrencySupport: currencies.loadCurrent,
                  priceCandidateSets: prices,
                  // This next, independent Catalog gate remains fail-closed. Reaching it proves the native
                  // Price equivalence gate passed; it is not evidence of full Catalog or monetary readiness.
                  catalogQuantity: {
                    assess: ({ effectiveAt }) =>
                      Effect.succeed({
                        effectiveAt,
                        outcome: 'UNAVAILABLE',
                        reason: 'Catalog provider is outside the native Price proof fixture.',
                        retryable: true,
                      }),
                  },
                } satisfies CurrentPricingDecisionAttemptSourcePorts;
                const source = makeCurrentPricingDecisionAttemptSource(sourcePorts);
                const absent = yield* source.loadFresh(request, trusted, 1);
                expect(Schema.is(ExactPriceAbsentResolutionSchema)(absent.exactPriceLines[0].exactPrice)).toBe(true);
                expect(absent.exactPriceLines[0].priceCandidateSetAuthorities[0]).toMatchObject({
                  authority: { generation: 0, kind: 'VIRTUAL_EMPTY' },
                  factProofs: [],
                  lookupEvidence: { effectiveAt: operationTime },
                });
                const adapters = yield* currentPricingDecisionWholeEvaluationAdaptersForScope(
                  transaction,
                  scope,
                  'a'.repeat(64),
                ).pipe(
                  Effect.provideService(
                    PricingExternalOwnerEvidenceValidation,
                    makePricingExternalOwnerEvidenceValidationService(),
                  ),
                );
                const context = yield* Layer.build(adapters);
                const composition = Context.get(context, CurrentPricingDecisionWholeComposition);
                const noPrice = yield* composition.buildNoApplicablePrice({
                  attempt: absent.attempt,
                  exactPriceLines: absent.exactPriceLines,
                  request,
                });
                expect(noPrice).toMatchObject({ outcome: 'NO_APPLICABLE_PRICE' });
                const initialAuthority = absent.exactPriceLines[0].priceCandidateSetAuthorities[0]?.authority;
                if (initialAuthority === undefined) {
                  return yield* Effect.die('Native virtual authority is required');
                }
                const virtualCurrent = yield* prices.verifyExactCandidateSetGeneration({
                  authority: yield* Schema.decodeUnknownEffect(ExactPriceCandidateSetAuthoritySchema)(initialAuthority),
                  effectiveAt: operationTime,
                  exactKey: key,
                  through: initialAuthority.observedAt,
                });
                expect(virtualCurrent).toMatchObject({ outcome: 'EXACT_PRICE_CANDIDATE_SET_GENERATION_CURRENT' });
                const invalidSourceCommand = yield* commandFor(scope, key);
                const missingSource = yield* transaction.invoke(definePriceGuardRoutine, [
                  { ...invalidSourceCommand, sourceEvidence: {} },
                ]);
                expect(missingSource).toMatchObject([
                  { payload: { outcome: 'CONFLICT', reason: 'SOURCE_PROVENANCE_INVALID' } },
                ]);
                const command = yield* commandFor(scope, key);
                const defined = yield* prices.define(command);
                expect(defined).toMatchObject({ outcome: 'CREATED' });
                const competitor = yield* prices.define(yield* commandFor(scope, key));
                expect(competitor).toMatchObject({ outcome: 'CONFLICT', reason: 'SOURCE_FACT_CONFLICT' });
                const found = yield* source.loadFresh(request, trusted, 1);
                const [line] = found.exactPriceLines;
                expect(Schema.is(ExactPriceFoundResolutionSchema)(line.exactPrice)).toBe(true);
                const [receipt] = line.priceCandidateSetAuthorities;
                expect(receipt).toMatchObject({
                  authority: { generation: 1, kind: 'PERSISTENT' },
                  factProofs: [{ factRef: command.priceRef.resourceId }],
                });
                expect(receipt?.authority.ownerRevision).not.toBe(receipt?.lookupEvidence?.ownerRevision);
                expect(line.quantityBasis).toMatchObject({ outcome: 'UNAVAILABLE' });
                if (receipt === undefined) {
                  return yield* Effect.die('Native persistent authority is required');
                }
                const persistentCurrent = yield* prices.verifyExactCandidateSetGeneration({
                  authority: yield* Schema.decodeUnknownEffect(ExactPriceCandidateSetAuthoritySchema)(
                    receipt.authority,
                  ),
                  effectiveAt: operationTime,
                  exactKey: key,
                  through: receipt.authority.observedAt,
                });
                expect(persistentCurrent).toMatchObject({ outcome: 'EXACT_PRICE_CANDIDATE_SET_GENERATION_CURRENT' });
                const direct = yield* prices.exactLookup({ effectiveAt: operationTime, exactKey: key });
                expect(Schema.is(ExactPriceLookupFoundSchema)(direct)).toBe(true);
                expect(direct).toMatchObject({
                  evidence: { ownerRevision: receipt?.lookupEvidence?.ownerRevision },
                });
                const future = yield* prices.exactLookup({
                  effectiveAt: '2099-01-01T00:00:00.000Z',
                  exactKey: key,
                });
                expect(Schema.is(ExactPriceLookupUnverifiableSchema)(future)).toBe(true);
                expect(future).toMatchObject({ reason: 'CURRENTNESS_UNVERIFIABLE' });
                const oldAuthority = absent.exactPriceLines[0].priceCandidateSetAuthorities[0]?.authority;
                if (oldAuthority === undefined) {
                  return yield* Effect.die(new Error('Native absence receipt is required'));
                }
                const generation = yield* prices.verifyExactCandidateSetGeneration({
                  authority: yield* Schema.decodeUnknownEffect(ExactPriceCandidateSetAuthoritySchema)(oldAuthority),
                  effectiveAt: request.decision.operationTime,
                  exactKey: key,
                  through: yield* Schema.decodeUnknownEffect(Schema.String)(receipt?.authority.observedAt),
                });
                expect(generation).toMatchObject({ outcome: 'EXACT_PRICE_CANDIDATE_SET_GENERATION_CHANGED' });
                // A different exact key remains actual owner-proven absence, never a foreign FOUND proof.
                const foreignKey = yield* Schema.decodeUnknownEffect(PriceIdentityKeySchema)({
                  ...key,
                  commercialScope: { ...key.commercialScope, channelId: 'B2B' },
                });
                const foreign = yield* prices.readExactCandidateSet({
                  effectiveAt: operationTime,
                  exactKey: foreignKey,
                });
                expect(foreign).toMatchObject({
                  candidateSet: { candidates: [] },
                  outcome: 'EXACT_PRICE_CANDIDATE_SET_CURRENT',
                });
                const foreignSource = makeCurrentPricingDecisionAttemptSource({
                  ...sourcePorts,
                  priceCandidateSets: {
                    readExactCandidateSet: () =>
                      prices.readExactCandidateSet({ effectiveAt: operationTime, exactKey: foreignKey }),
                  },
                });
                const wrongTarget = yield* foreignSource.loadFresh(request, trusted, 1).pipe(Effect.flip);
                expect(wrongTarget).toMatchObject({ kind: 'UNVERIFIABLE' });
                const retirementAt = '2026-10-19T09:00:01.000Z';
                const schedule = yield* prices.readSchedule(
                  command.priceRef,
                  DateTime.toDateUtc(DateTime.makeUnsafe(retirementAt)),
                );
                if (schedule.outcome !== 'PRICE_SCHEDULE_CURRENT' || schedule.schedule.current === undefined) {
                  return yield* Effect.die('Native Price must have a Current schedule before retirement');
                }
                const { current } = schedule.schedule;
                const retirementInvocationId = yield* nextId;
                const retirement = prices
                  .revise({
                    actingPrincipalId: scope.principalId,
                    actionInvocationId: retirementInvocationId,
                    expectedCurrent: {
                      effectivePeriod: current.effectivePeriod,
                      priceRef: command.priceRef,
                      revision: current.definition.revision.revision,
                      revisionId: current.definition.revision.revisionId,
                      scheduleRevision: schedule.schedule.scheduleRevision,
                    },
                    intent: 'RETIRE_CURRENT',
                    priceRef: command.priceRef,
                    reason: 'Change native source between exact and candidate reads.',
                    requestCorrelationId: retirementInvocationId,
                    trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(retirementAt)),
                  })
                  .pipe(
                    Effect.tap((result) => Effect.sync(() => expect(result).toMatchObject({ outcome: 'REVISED' }))),
                  );
                const changedSource = makeCurrentPricingDecisionAttemptSource({
                  ...sourcePorts,
                  priceCandidateSets: {
                    readExactCandidateSet: (query) =>
                      retirement.pipe(Effect.andThen(() => prices.readExactCandidateSet(query))),
                  },
                });
                const changed = yield* changedSource.loadFresh(request, trusted, 1).pipe(Effect.flip);
                expect(changed).toMatchObject({ kind: 'UNVERIFIABLE' });
                const retiredRequest = requestFor(key, '2026-10-19T09:00:02.000Z');
                const retiredTrusted = {
                  ...trusted,
                  purchaseContextEvidence: {
                    ...trusted.purchaseContextEvidence,
                    currentness: {
                      ...trusted.purchaseContextEvidence.currentness,
                      evaluatedAt: retiredRequest.decision.operationTime,
                    },
                  },
                };
                const persistentAbsent = yield* source.loadFresh(retiredRequest, retiredTrusted, 1);
                expect(
                  Schema.is(ExactPriceAbsentResolutionSchema)(persistentAbsent.exactPriceLines[0].exactPrice),
                ).toBe(true);
                expect(persistentAbsent.exactPriceLines[0].priceCandidateSetAuthorities[0]).toMatchObject({
                  authority: { generation: 2, kind: 'PERSISTENT' },
                  factProofs: [],
                });
                const [retiredReceipt] = persistentAbsent.exactPriceLines[0].priceCandidateSetAuthorities;
                if (retiredReceipt === undefined) {
                  return yield* Effect.die('Native retired Price authority is required');
                }
                const oldGeneration = yield* prices.verifyExactCandidateSetGeneration({
                  authority: yield* Schema.decodeUnknownEffect(ExactPriceCandidateSetAuthoritySchema)(
                    receipt.authority,
                  ),
                  effectiveAt: operationTime,
                  exactKey: key,
                  through: retiredReceipt.authority.observedAt,
                });
                expect(oldGeneration).toMatchObject({ outcome: 'EXACT_PRICE_CANDIDATE_SET_GENERATION_CHANGED' });
                const persistentNoPrice = yield* composition.buildNoApplicablePrice({
                  attempt: persistentAbsent.attempt,
                  exactPriceLines: persistentAbsent.exactPriceLines,
                  request: retiredRequest,
                });
                expect(persistentNoPrice).toMatchObject({ outcome: 'NO_APPLICABLE_PRICE' });
                return noPrice;
              },
            ),
          )
          .pipe(Effect.provideContext(fixtureContext));
      }),
    ).pipe(withNativeCrypto),
);

it.live('rejects missing, malformed, backdated, and future native generation-fence instants (#1279)', () =>
  Effect.scoped(
    Effect.gen(function* invalidNativeGenerationIntervals() {
      const fixture = yield* makeNativeReadTestContext({
        contextPermissions: [],
        moduleId: 'commerce.pricing',
        ownerFixtureRetention: 'retain-complete-context',
      });
      const fixtureContext = yield* Layer.build(fixture.layer);
      for (const invalid of [
        { expectedCode: '22023', observedAt: '2026-10-19T08:59:59.000Z', through: operationTime },
        { expectedCode: '22023', observedAt: operationTime, through: '2026-10-19T08:59:59.000Z' },
        { expectedCode: '22023', observedAt: operationTime, through: '2099-01-01T00:00:00.000Z' },
        { expectedCode: '22007', observedAt: 'not-an-instant', through: operationTime },
        { expectedCode: '22023', observedAt: null, through: operationTime },
        { expectedCode: '22023', observedAt: operationTime, through: null },
      ]) {
        const failure = yield* fixture
          .prepareOwner(
            Effect.fn('test.invalidNativePriceInterval')(function* invalidNativePriceInterval(transaction, scope) {
              const rows = yield* transaction.invoke(verifyExactPriceCandidateSetGenerationRoutine, [
                {
                  authority: {
                    generation: 0,
                    kind: 'VIRTUAL_EMPTY',
                    observedAt: invalid.observedAt,
                    ownerRevision: 'invalid-interval:test',
                    ownerRootRef: 'invalid-interval:root',
                    predicateRef: 'invalid-interval:predicate',
                    verificationRef: 'invalid-interval:proof',
                  },
                  effectiveAt: operationTime,
                  exactKey: identityFor(scope),
                  through: invalid.through,
                },
              ]);
              return rows;
            }),
          )
          .pipe(Effect.provideContext(fixtureContext), Effect.flip);
        expect(failure).toMatchObject({
          code: 'scoped_routine_invocation_failed',
          postgresCode: { value: invalid.expectedCode },
        });
      }
    }),
  ).pipe(withNativeCrypto),
);

// #1279 tests the Pricing native proof/comparator and final fence. These Catalog,
// Market and Guest contracts are explicit validated TEST prerequisites, not claims
// that foreign providers, finite Current production or public authentication ran.
const declaredQuantity1279: CurrentPricingDecisionAttemptSourcePorts['catalogQuantity'] = {
  assess: ({ effectiveAt, handoff, price, tier }) => {
    const { ownerRevision: generation } = handoff;
    const { predicateRef } = handoff.completeness.scope;
    const requested = { quantity: handoff.quantity.requested, quantityBasis: handoff.quantityBasis };
    const purchase = { quantity: handoff.quantity.resulting, quantityBasis: handoff.quantityBasis };
    const endpoints = { price, purchase, requested };
    const predicate = {
      effectiveAt,
      price,
      requestedQuantity: requested.quantity,
      requestedQuantityBasis: requested.quantityBasis,
      requestedUnitRef: handoff.unitRef,
      selection: handoff.selection,
    };
    if (tier !== undefined) {
      Object.assign(endpoints, { tier });
      Object.assign(predicate, { tier });
    }
    return Schema.decodeUnknownEffect(QuantityBasisCompatibilityResponseSchema)({
      completeness: {
        observedAt: effectiveAt,
        ownerRevision: generation,
        scope: { kind: 'EXACT_PREDICATE', predicateRef },
      },
      currentness: { observedAt: effectiveAt, ownerRevision: generation, status: 'CURRENT' },
      currentnessEvidence: {
        effectiveAt,
        generation,
        observedAt: effectiveAt,
        predicateRef,
        revalidatedAt: effectiveAt,
        verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
      },
      effectiveAt,
      endpoints,
      equivalentSelectionKey: handoff.equivalentSelectionKey,
      generation,
      hierarchyRevision: handoff.hierarchyRevision,
      observedAt: effectiveAt,
      outcome: 'NO_CONVERSION_REQUIRED',
      ownerModuleId: 'commerce.catalog',
      ownerRevision: generation,
      requestedOwnerRevision: handoff.ownerRevision,
      requestedQuantity: requested.quantity,
      requestedQuantityBasis: requested.quantityBasis,
      requestedUnitRef: handoff.unitRef,
      selection: handoff.selection,
      source: 'CATALOG_OWNER_CURRENT_READ',
      verificationReceipt: {
        generation,
        issuedAt: effectiveAt,
        ownerModuleId: 'commerce.catalog',
        ownerRevision: generation,
        predicate,
        predicateRef,
        verificationRef: 'native-1279:declared-quantity-proof',
      },
    }).pipe(Effect.orDie);
  },
};
type IntegratedExternalInput1279 = Parameters<CurrentPricingDecisionExternalOwnerEvidencePort['loadFresh']>[0];
type DeclaredFenceSource1279 = typeof PricingMaterialEvidenceFenceSourceSchema.Type;
const declaredExternal1279 = Effect.fn('test.1279.declaredExternal')(function* declaredExternal1279(
  input: IntegratedExternalInput1279,
) {
  const { attempt, commercialTotal, purchaseContextEvidence, request } = input;
  const { decision, subject } = request;
  const at = decision.operationTime;
  const { requestedAt } = attempt.snapshot;
  const nativeClock = yield* Clock.Clock;
  const validatedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis));
  const validation = makePricingExternalOwnerEvidenceValidationService();
  const [line] = decision.lines;
  if (line === undefined) {
    return yield* Effect.die('One native Pricing line is required');
  }
  const sourceFor = (
    ownerModuleId: string,
    root: string,
    predicate: string,
    revision: string,
    verificationRef: string,
    facts: readonly { factRef: string; factRevisionRef: string }[],
  ) => {
    const ownerScope = { ownerModuleId, ownerRootRef: root, predicateRef: predicate, tenantId: decision.tenantId };
    const temporal = {
      effectiveAt: at,
      evaluatedAt: at,
      evaluationMode: 'CURRENT_AT_OWNER_EVALUATION',
      observedAt: validatedAt,
      requestedAt,
    };
    return Schema.decodeUnknownEffect(PricingSourceEvidenceVerifiedPresentSchema)({
      _tag: 'VERIFIED_PRESENT',
      completeness: {
        completenessEvidence: {
          observedAt: validatedAt,
          ownerRevision: revision,
          scope: { kind: 'EXACT_PREDICATE', predicateRef: predicate },
        },
        family: 'COMMERCIAL_CONTEXT',
        ownerScope,
        ownerSetRevisionRef: revision,
        temporal,
        verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef },
      },
      currentFacts: facts.map((fact) => ({
        ...fact,
        effectivePeriod: { effectiveFrom: at, effectiveTo: null },
        family: 'COMMERCIAL_CONTEXT',
        ownerScope,
        temporal,
        verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef },
      })),
      request: { effectiveAt: at, family: 'COMMERCIAL_CONTEXT', ownerScope, requestedAt },
    });
  };
  const originalHandoff = line.catalog;
  const handoff = {
    ...originalHandoff,
    completeness: { ...originalHandoff.completeness, observedAt: validatedAt },
    evidence: {
      ...originalHandoff.evidence,
      assessedAt: validatedAt,
      membership: { ...originalHandoff.evidence.membership, observedAt: validatedAt },
    },
  };
  const catalogSource = yield* sourceFor(
    'commerce.catalog',
    handoff.equivalentSelectionKey,
    handoff.completeness.scope.predicateRef,
    handoff.completeness.ownerRevision,
    handoff.evidence.membership.attestationId,
    handoff.evidence.basis.map(({ source }) => ({
      factRef: source.resourceRef.resourceId,
      factRevisionRef: source.revisionId ?? String(source.revision),
    })),
  );
  const catalog = {
    assessment: handoff.evidence,
    expectedEffectiveAt: at,
    expectedOwnerRootRef: handoff.equivalentSelectionKey,
    expectedPredicateRef: handoff.completeness.scope.predicateRef,
    expectedSelection: handoff.selection,
    requestedAt,
    sourceEvidence: catalogSource,
  };
  const marketSource = yield* sourceFor(
    'commerce.market-catalog',
    'native-1279:declared-market-root',
    'native-1279:declared-market-predicate',
    'native-1279:declared-market-set',
    'native-1279:declared-market-proof',
    [{ factRef: decision.commercialScope.marketId, factRevisionRef: 'native-1279:declared-market-revision' }],
  );
  const seller = {
    moduleId: 'core.identity',
    resourceId: decision.commercialScope.sellingLegalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId: decision.tenantId,
  };
  const marketRef = {
    moduleId: 'commerce.market-catalog',
    resourceId: decision.commercialScope.marketId,
    resourceType: 'commerce.market-catalog.market',
    tenantId: decision.tenantId,
  };
  const response = yield* Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceResponseSchema)({
    market: {
      channels: [decision.commercialScope.channelId],
      definitionRevisionRef: {
        ...marketRef,
        resourceId: 'native-1279:declared-market-definition',
        resourceType: 'commerce.market-catalog.market-definition-revision',
      },
      effectivePeriod: { startsAt: at },
      jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
      lifecycle: 'ACTIVE',
      marketCode: 'CZ',
      marketRef,
      purpose: 'Explicit non-Pricing prerequisite',
      revision: 1,
      sellingLegalEntityRef: seller,
      supportedLocales: ['cs-CZ'],
    },
    outcome: 'PRICING_MARKET_SOURCE_PRESENT',
    receipt: {
      authority: {
        generation: 1,
        observedAt: validatedAt,
        ownerRootRef: 'native-1279:declared-market-root',
        ownerSetRevisionRef: 'native-1279:declared-market-set',
        predicateRef: 'native-1279:declared-market-predicate',
        verificationRef: 'native-1279:declared-market-proof',
      },
      currentFacts: [
        {
          effectivePeriod: { startsAt: at },
          factRef: decision.commercialScope.marketId,
          factRevisionRef: 'native-1279:declared-market-revision',
          verificationRef: 'native-1279:declared-market-proof',
        },
      ],
      state: 'PRESENT',
    },
    request: {
      commercialScope: { channel: decision.commercialScope.channelId, marketRef, sellingLegalEntityRef: seller },
      effectiveAt: at,
      requestedAt,
    },
  });
  assert(response.outcome === 'PRICING_MARKET_SOURCE_PRESENT');
  const market = {
    expectedCommercialScope: decision.commercialScope,
    expectedEffectiveAt: at,
    expectedOwnerRootRef: 'native-1279:declared-market-root',
    expectedPredicateRef: 'native-1279:declared-market-predicate',
    requestedAt,
    response,
    sourceEvidence: marketSource,
    tenantId: decision.tenantId,
  };
  const acceptedCatalog = yield* validation.validateCatalogSelection(catalog);
  const acceptedMarket = yield* validation.validateMarket(market);
  const promotion = { kind: 'PROMOTION_NOT_SELECTED' as const };
  const retained = yield* validation.retainValidatedOwnerEvidence({
    candidateRef: commercialTotal.candidateRef,
    catalogSelections: [{ occurrenceId: line.occurrenceId, validation: acceptedCatalog }],
    decision,
    market: acceptedMarket,
    promotion,
    requestedAt,
    subject,
    validatedAt,
  });
  const compatibilityRequest = {
    effectiveAt: validatedAt,
    handoff,
    price: {
      quantity: line.pricingBasis.quantity,
      quantityBasis: {
        ...handoff.quantityBasis,
        targetRef: handoff.selection.packageOption?.optionRef ?? handoff.selection.variantRef,
        unitRef: line.pricingBasis.unitRef,
      },
    },
  };
  const compatibilityResponse = yield* declaredQuantity1279.assess(compatibilityRequest);
  const equivalenceRequest = {
    anchorSelection: line.catalog.selection,
    effectiveAt: at,
    members: [{ handoff: originalHandoff, occurrenceId: line.occurrenceId }],
  };
  const equivalenceResponse = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceResponseSchema)({
    assessments: [
      { handoff, role: 'ANCHOR' },
      { handoff, occurrenceId: line.occurrenceId, role: 'MEMBER' },
    ],
    currentness: {
      effectiveAt: at,
      observedAt: validatedAt,
      status: 'CURRENT',
      validThrough: '2027-01-01T00:00:00.000Z',
    },
    currentnessEvidence: {
      effectiveAt: at,
      generation: 'native-1279:declared-equivalence-generation',
      observedAt: validatedAt,
      predicateRef: 'native-1279:declared-equivalence-predicate',
      revalidatedAt: validatedAt,
      validThrough: '2027-01-01T00:00:00.000Z',
      verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
    },
    evidence: {
      anchorSelection: handoff.selection,
      assessmentId: 'native-1279:declared-equivalence-assessment',
      effectiveAt: at,
      members: [{ occurrenceId: line.occurrenceId, selection: handoff.selection }],
      observedAt: validatedAt,
      ownerModuleId: 'commerce.catalog',
      ownerRevision: 'native-1279:declared-equivalence-owner',
      purpose: 'PRICING',
      status: 'CONFIRMED',
      validThrough: '2027-01-01T00:00:00.000Z',
    },
    generation: 'native-1279:declared-equivalence-generation',
    outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
    verificationReceipt: {
      generation: 'native-1279:declared-equivalence-generation',
      issuedAt: validatedAt,
      ownerModuleId: 'commerce.catalog',
      ownerRevision: 'native-1279:declared-equivalence-owner',
      predicate: {
        anchor: {
          quantityBasis: handoff.quantityBasis,
          requestedQuantity: handoff.quantity.requested,
          selection: handoff.selection,
        },
        effectiveAt: at,
        members: [
          {
            occurrenceId: line.occurrenceId,
            quantityBasis: handoff.quantityBasis,
            requestedQuantity: handoff.quantity.requested,
            selection: handoff.selection,
          },
        ],
        purpose: 'PRICING',
      },
      predicateRef: 'native-1279:declared-equivalence-predicate',
      verificationRef: 'native-1279:declared-equivalence-proof',
    },
  });
  const equivalenceSource = yield* sourceFor(
    'commerce.catalog',
    'native-1279:declared-equivalence-assessment',
    'native-1279:declared-equivalence-predicate',
    'native-1279:declared-equivalence-owner',
    'native-1279:declared-equivalence-proof',
    [
      {
        factRef: 'native-1279:declared-equivalence-assessment',
        factRevisionRef: 'native-1279:declared-equivalence-generation',
      },
    ],
  ).pipe(
    Effect.flatMap((source) =>
      Schema.decodeUnknownEffect(PricingSourceEvidenceVerifiedPresentSchema)({
        ...source,
        completeness: {
          ...source.completeness,
          completenessEvidence: {
            ...source.completeness.completenessEvidence,
            nextApplicabilityBoundary: '2027-01-01T00:00:00.000Z',
          },
          temporal: { ...source.completeness.temporal, nextMaterialBoundary: '2027-01-01T00:00:00.000Z' },
        },
        currentFacts: source.currentFacts.map((fact) => ({
          ...fact,
          effectivePeriod: { ...fact.effectivePeriod, effectiveTo: '2027-01-01T00:00:00.000Z' },
          temporal: { ...fact.temporal, nextMaterialBoundary: '2027-01-01T00:00:00.000Z' },
        })),
      }),
    ),
  );
  const fenceSources = yield* Effect.forEach(
    [
      {
        sourceEvidence: catalogSource,
        verificationMaterial: {
          compatibilityRequest,
          compatibilityResponse,
          handoff,
          kind: 'CATALOG_LINE_AUTHORITY',
          line,
          request: { amount: handoff.quantity.requested, purpose: 'PRICING', selection: handoff.selection },
        },
      },
      {
        sourceEvidence: equivalenceSource,
        verificationMaterial: {
          kind: 'CATALOG_EQUIVALENCE_AUTHORITY',
          request: equivalenceRequest,
          response: equivalenceResponse,
        },
      },
      {
        sourceEvidence: marketSource,
        verificationMaterial: {
          commercialScope: decision.commercialScope,
          kind: 'MARKET_CONTEXT_AUTHORITY',
          receipt: yield* Schema.encodeUnknownEffect(PricingCurrentMarketEvidenceResponseSchema)(response).pipe(
            Effect.map((encoded) => {
              assert(encoded.outcome === 'PRICING_MARKET_SOURCE_PRESENT');
              return encoded.receipt;
            }),
          ),
        },
      },
      {
        verificationMaterial: {
          evidence: purchaseContextEvidence,
          kind: 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY',
          request: {
            actor: { kind: 'GUEST' },
            operationTime: at,
            purchasingContext: { ...decision.purchasingContext, ...decision.commercialScope },
            subject,
            tenantId: decision.tenantId,
          },
        },
      },
    ],
    (source) => Schema.decodeUnknownEffect(PricingMaterialEvidenceFenceSourceSchema)(source),
  );
  return { fenceSources, publication: { catalog: [catalog] as const, market, promotion, subject }, retained };
});

const declaredExpectation1279 = (
  source: DeclaredFenceSource1279,
): readonly PricingMaterialEvidenceFenceExpectation[] => {
  if (!('sourceEvidence' in source)) {
    return [];
  }
  assert(Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source.sourceEvidence));
  const { completeness, currentFacts } = source.sourceEvidence;
  const expectation = {
    currentFacts: currentFacts.map(({ factRef, factRevisionRef, verification }) => ({
      factRef,
      factRevisionRef,
      verificationRef: verification.verificationRef,
    })),
    evidenceObservedAt: completeness.temporal.observedAt,
    evidenceVerificationRef: completeness.verification.verificationRef,
    family: completeness.family,
    ownerModuleId: completeness.ownerScope.ownerModuleId,
    ownerRootRef: completeness.ownerScope.ownerRootRef,
    ownerSetRevisionRef: completeness.ownerSetRevisionRef,
    predicateRef: completeness.ownerScope.predicateRef,
    tenantId: completeness.ownerScope.tenantId,
  };
  if (completeness.temporal.nextMaterialBoundary !== undefined) {
    Object.assign(expectation, { nextMaterialBoundary: completeness.temporal.nextMaterialBoundary });
  }
  return [expectation];
};

// Independent fixed foreign prerequisites only. The Pricing gateway below is real
// native verification and is never replaced with an echo of requested expectations.
const declaredForeignFence1279 = (
  declared: () => readonly DeclaredFenceSource1279[],
  owner: string,
): PricingOwnerMaterialEvidenceFenceGateway => {
  let observations: readonly PricingMaterialEvidenceFenceSourceObservation[] = [];
  return {
    confirmObservedGenerationsThrough: (input) =>
      Effect.sync(() => {
        expect(input.observations).toEqual(observations);
        return {
          confirmations: observations.map((source) => ({
            currentFacts: source.currentFacts,
            currentInvalidationGenerationRef: source.currentInvalidationGenerationRef,
            currentOwnerSetRevisionRef: source.currentOwnerSetRevisionRef,
            evidenceInvalidationGenerationRef: source.evidenceInvalidationGenerationRef,
            evidenceVerificationRef: source.evidenceVerificationRef,
          })),
          verifiedThrough: input.through,
        };
      }),
    verifyOpaqueProofsAgainstCurrentState: (input) =>
      Effect.gen(function* declaredOwnerFence1279() {
        const sources = declared().filter((source) =>
          'sourceEvidence' in source
            ? source.sourceEvidence.completeness.ownerScope.ownerModuleId === owner
            : owner === 'commerce.customer-context',
        );
        expect(input.typedSources).toEqual(sources);
        const expected = sources.flatMap(declaredExpectation1279);
        expect(input.sources).toEqual(expected);
        const nativeClock = yield* Clock.Clock;
        const now = DateTime.formatIso(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis));
        observations = expected.map((source) => ({
          ...source,
          currentInvalidationGenerationRef: 'native-1279:declared-fixed',
          currentOwnerSetRevisionRef: source.ownerSetRevisionRef,
          evidenceInvalidationGenerationRef: 'native-1279:declared-fixed',
          observedAt: now,
        }));
        return { completedAt: now, observations };
      }),
  };
};

const rejectAlteredNativeBinding1279 = Effect.fn('test.1279.rejectAlteredNativeBinding')(
  function* rejectAlteredNativeBinding1279(
    material: PricingMaterialEvidenceAssemblyRequest,
    change: 'missing' | 'digest' | 'effective-at' | 'target' | 'fact',
  ) {
    const fence = material.ownerFenceRequest;
    assert(fence !== undefined);
    const sources = fence.sources.map((source): DeclaredFenceSource1279 => {
      if (source.verificationMaterial.kind !== 'PRICING_PRICE_AUTHORITY' || !('sourceEvidence' in source)) {
        return source;
      }
      const authority = source.verificationMaterial;
      const receipt = authority.ownerReadReceipt;
      assert(receipt.lookupEvidence !== undefined);
      if (change === 'target') {
        return {
          ...source,
          verificationMaterial: {
            ...authority,
            lookupRequest: {
              ...authority.lookupRequest,
              exactKey: {
                ...authority.lookupRequest.exactKey,
                commercialScope: {
                  ...authority.lookupRequest.exactKey.commercialScope,
                  marketId: 'native-1279:foreign-market',
                },
              },
            },
          },
        };
      }
      if (change === 'missing') {
        const { lookupEvidence: omitted, ...withoutBinding } = receipt;
        expect(omitted).toBeDefined();
        return { ...source, verificationMaterial: { ...authority, ownerReadReceipt: withoutBinding } };
      }
      if (change === 'fact') {
        return {
          ...source,
          verificationMaterial: {
            ...authority,
            ownerReadReceipt: {
              ...receipt,
              factProofs: receipt.factProofs.map((fact) => ({ ...fact, factRef: 'native-1279:foreign-price' })),
            },
          },
        };
      }
      const lookupEvidence =
        change === 'digest'
          ? { ...receipt.lookupEvidence, ownerRevision: 'native-1279:foreign-digest' }
          : { ...receipt.lookupEvidence, effectiveAt: '2026-10-19T09:00:03.000Z' };
      return { ...source, verificationMaterial: { ...authority, ownerReadReceipt: { ...receipt, lookupEvidence } } };
    });
    const failure = yield* assemblePricingMaterialEvidence({
      ...material,
      ownerFenceRequest: { ...fence, sources },
    }).pipe(Effect.flip);
    expect(Schema.is(PricingMaterialEvidenceUnverifiableFailure)(failure)).toBe(true);
  },
);

const nativeWhole1279 = Effect.fn('test.1279.nativeWhole')(function* nativeWhole1279(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) {
  const key = identityFor(scope);
  const request = requestFor(key);
  const command = yield* commandFor(scope, key);
  const retirementInvocation = yield* nextId;
  let retireBeforeCandidateRead = false;
  let nativeRetirements = 0;
  const prices = yield* pricePersistenceForScope(transaction, scope);
  const currencies = yield* currencySupportPersistenceForScope(transaction, scope, 'a'.repeat(64));
  const resolver = yield* exactPriceResolutionServiceForScope(transaction, scope, 'a'.repeat(64));
  yield* currencies.setCurrent({
    actingPrincipalId: scope.principalId,
    actionInvocationId: yield* nextId,
    expectedState: { state: 'ABSENT' },
    intendedEffectivePeriod: { effectiveFrom: operationTime, effectiveTo: null },
    intent: 'ESTABLISH_CURRENT',
    reason: 'Native whole integration prerequisite',
    schemaVersion: '2',
    supportedCurrencies: ['CZK'],
    tenantId: scope.tenantId,
    trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
  });
  const trusted = {
    purchaseContextEvidence: yield* Schema.decodeUnknownEffect(PricingPurchaseContextVerificationEvidenceSchema)({
      currentness: {
        evaluatedAt: operationTime,
        observedAt: operationTime,
        validFrom: operationTime,
        validTo: null,
      },
      ownerRef: request.decision.purchasingContext.contextRef,
      ownerRevisionRef: request.decision.purchasingContext.contextRevision,
      subjectAuthority: {
        guestEvidenceAuthorityRef: 'native-1279:guest-owner',
        guestSessionAuthorityRef: 'native-1279:session-owner',
        kind: 'GUEST',
        subject: request.subject,
        subjectAuthorityRevisionRef: 'native-1279:guest-revision',
      },
      verificationRef: 'native-1279:purchase-proof',
      verifiedScope: {
        channelId: 'B2C',
        legalEntityId: scope.legalEntityId,
        marketId: 'CZ',
        tenantId: scope.tenantId,
      },
    }),
    sellingLegalEntityId: key.commercialScope.sellingLegalEntityId,
    tenantId: scope.tenantId,
  };
  const source = makeCurrentPricingDecisionAttemptSource({
    catalogQuantity: declaredQuantity1279,
    exactPrice: resolver,
    interpreter: { interpret: () => Effect.die('Guest does not use Price Group interpretation') },
    loadCurrencySupport: currencies.loadCurrent,
    priceCandidateSets: {
      readExactCandidateSet: Effect.fn('test.1279.interleavedNativeRead')(function* interleavedNativeRead(query) {
        if (retireBeforeCandidateRead) {
          retireBeforeCandidateRead = false;
          const retirementAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-19T09:00:01.000Z'));
          const schedule = yield* prices.readSchedule(command.priceRef, retirementAt);
          assert(schedule.outcome === 'PRICE_SCHEDULE_CURRENT' && schedule.schedule.current !== undefined);
          const { current } = schedule.schedule;
          const invocation = retirementInvocation;
          expect(
            yield* prices.revise({
              actingPrincipalId: scope.principalId,
              actionInvocationId: invocation,
              expectedCurrent: {
                effectivePeriod: current.effectivePeriod,
                priceRef: command.priceRef,
                revision: current.definition.revision.revision,
                revisionId: current.definition.revision.revisionId,
                scheduleRevision: schedule.schedule.scheduleRevision,
              },
              intent: 'RETIRE_CURRENT',
              priceRef: command.priceRef,
              reason: 'Actual native material change between bounded attempt reads',
              requestCorrelationId: invocation,
              trustedOperationAt: retirementAt,
            }),
          ).toMatchObject({ outcome: 'REVISED' });
          nativeRetirements += 1;
        }
        return yield* prices.readExactCandidateSet(query);
      }),
    },
  });
  const adapters = yield* currentPricingDecisionWholeEvaluationAdaptersForScope(
    transaction,
    scope,
    'a'.repeat(64),
  ).pipe(
    Effect.provideService(PricingExternalOwnerEvidenceValidation, makePricingExternalOwnerEvidenceValidationService()),
  );
  const context = yield* Layer.build(adapters);
  const nativeFence = yield* pricingCurrentDecisionPricingOwnerFinalFenceGatewayForScope(
    transaction,
    scope,
    'a'.repeat(64),
  );
  let foreignSources: readonly DeclaredFenceSource1279[] = [];
  const ordinals: number[] = [];
  let nativeFenceChecks = 0;
  let nativeConfirmations = 0;
  const actualPricingFence: PricingOwnerMaterialEvidenceFenceGateway = {
    confirmObservedGenerationsThrough: (input) => {
      nativeConfirmations += 1;
      return nativeFence.confirmObservedGenerationsThrough(input);
    },
    verifyOpaqueProofsAgainstCurrentState: (input) => {
      nativeFenceChecks += 1;
      return nativeFence.verifyOpaqueProofsAgainstCurrentState(input);
    },
  };
  const fence = makePricingMaterialEvidenceOwnerFinalFenceFromGateways(
    {
      'commerce.catalog': declaredForeignFence1279(() => foreignSources, 'commerce.catalog'),
      'commerce.customer-context': declaredForeignFence1279(() => foreignSources, 'commerce.customer-context'),
      'commerce.market-catalog': declaredForeignFence1279(() => foreignSources, 'commerce.market-catalog'),
      'commerce.pricing': actualPricingFence,
      'commerce.promotion': declaredForeignFence1279(() => [], 'commerce.promotion'),
    },
    'a'.repeat(64),
  );
  const whole = makeCurrentPricingDecisionWholeEvaluationService({
    attemptSource: {
      loadFresh: (input, owner, ordinal) => {
        ordinals.push(ordinal);
        return source.loadFresh(input, owner, ordinal);
      },
    },
    composition: Context.get(context, CurrentPricingDecisionWholeComposition),
    discountReader: {
      loadCurrent: (...args) => Context.get(context, CurrentPricingDecisionDiscountSetReader).loadCurrent(...args),
    },
    externalOwnerEvidence: {
      loadFresh: (input) =>
        declaredExternal1279(input).pipe(
          Effect.tap((external) =>
            Effect.sync(() => {
              foreignSources = external.fenceSources;
            }),
          ),
          Effect.orDie,
        ),
    },
    feeReader: {
      loadCurrent: (...args) => Context.get(context, CurrentPricingDecisionFeeSetReader).loadCurrent(...args),
    },
    floorReader: {
      loadCurrent: (...args) => Context.get(context, CurrentPricingDecisionZeroFloorSetReader).loadCurrent(...args),
    },
    promotionEvaluation: { evaluate: () => Effect.die('No Promotion selected in native1279') },
    tierReader: {
      loadCurrent: (...args) => Context.get(context, CurrentPricingDecisionTierSetReader).loadCurrent(...args),
    },
  });
  const evaluation = makeCurrentPricingDecisionEvaluationService(whole, (input) =>
    publishOrdinaryCurrentPricingForCustomer(input).pipe(
      Effect.provideService(
        PricingExternalOwnerEvidenceValidation,
        makePricingExternalOwnerEvidenceValidationService(),
      ),
      Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, fence),
    ),
  );
  const empty = yield* evaluation.evaluate(request, trusted);
  expect(empty.kind).toBe('NON_RESOLVED');
  expect(empty).toMatchObject({ outcome: { outcome: 'NO_APPLICABLE_PRICE' } });
  expect(ordinals).toEqual([1]);
  expect(yield* prices.define(command)).toMatchObject({ outcome: 'CREATED' });
  // Establish the independent ZERO_FLOOR owner's genuine set head through governance.
  // No floor authorization is created or consumed by this positive-price scenario.
  const floors = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
  expect(
    yield* floors.manage({
      actingPrincipalId: scope.principalId,
      actionInvocationId: yield* nextId,
      approvalRevision: 'native-1279:floor-prerequisite-approval',
      authorization: {
        authorizationRef: 'native-1279:unused-floor-authorization',
        authorizationRevision: 'native-1279:unused-floor-revision',
        businessScope: {
          catalogSelection: key.catalogSelection,
          commercialScope: key.commercialScope,
          pricingBasis: key.unitBasis,
          tenantId: scope.tenantId,
        },
        coveredMeaning: { audienceRefs: [], materialRevisionRefs: ['native-1279:unused-floor-material'] },
        currencyCode: key.currencyCode,
        economicCoverage: { maximumFloorAdjustment: '1', minimumRawAmount: '-1' },
        effectivePeriod: { endsAt: '2027-01-01T00:00:00.000Z', startsAt: operationTime },
        governanceEvidence: {
          approvalEvidenceRef: 'native-1279:floor-prerequisite',
          approvedByPrincipalRef: scope.principalId,
          reason: 'Initialize genuine independent floor authority',
        },
      },
      expectedSetGeneration: 1,
      intent: 'APPROVE',
      reason: 'Initialize independent floor authority for native whole evaluation',
      requestCorrelationId: 'native-1279:floor-prerequisite',
      trustedOperationAt: operationTime,
      validityPeriod: { endsAt: '2027-01-01T00:00:00.000Z', startsAt: operationTime },
    }),
  ).toMatchObject({ outcome: 'ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED' });
  ordinals.length = 0;
  const stable = yield* evaluation.evaluate(request, trusted);
  assert(stable.kind === 'PRICE_RESOLVED');
  expect(ordinals).toEqual([1]);
  expect(nativeFenceChecks).toBe(1);
  expect(nativeConfirmations).toBe(1);
  yield* Schema.decodeUnknownEffect(PricingCommercialTotalSafeProjectionSchema, { onExcessProperty: 'error' })(
    stable.projection,
  );
  expect(stable.projection.pricingNetCommercialTotal).toMatchObject({ amount: '100', currencyCode: 'CZK' });
  const materialRequest = stable.materialEvidence.sourceEvidence;
  assert(materialRequest.ownerFenceRequest !== undefined);
  const nativePrice = materialRequest.ownerFenceRequest.sources.find(
    (item) => item.verificationMaterial.kind === 'PRICING_PRICE_AUTHORITY',
  );
  assert(
    nativePrice !== undefined &&
      'sourceEvidence' in nativePrice &&
      nativePrice.verificationMaterial.kind === 'PRICING_PRICE_AUTHORITY',
  );
  assert(nativePrice.verificationMaterial.ownerReadReceipt.lookupEvidence !== undefined);
  expect(nativePrice.verificationMaterial.ownerReadReceipt.authority.ownerRevision).not.toBe(
    nativePrice.verificationMaterial.ownerReadReceipt.lookupEvidence.ownerRevision,
  );
  yield* rejectAlteredNativeBinding1279(materialRequest, 'missing');
  yield* rejectAlteredNativeBinding1279(materialRequest, 'digest');
  yield* rejectAlteredNativeBinding1279(materialRequest, 'effective-at');
  yield* rejectAlteredNativeBinding1279(materialRequest, 'target');
  yield* rejectAlteredNativeBinding1279(materialRequest, 'fact');
  const duplicatedRequest = {
    ...materialRequest,
    ownerFenceRequest: {
      ...materialRequest.ownerFenceRequest,
      sources: [...materialRequest.ownerFenceRequest.sources, nativePrice],
    },
  };
  expect((yield* assemblePricingMaterialEvidence(duplicatedRequest)).outcome).toBe('PRICING_MATERIAL_EVIDENCE_READY');
  const conflict: DeclaredFenceSource1279 = {
    ...nativePrice,
    verificationMaterial: {
      ...nativePrice.verificationMaterial,
      ownerReadReceipt: {
        ...nativePrice.verificationMaterial.ownerReadReceipt,
        lookupEvidence: {
          ...nativePrice.verificationMaterial.ownerReadReceipt.lookupEvidence,
          ownerRevision: 'native-1279:conflicting-retained-digest',
        },
      },
    },
  };
  expect(
    Schema.is(PricingMaterialEvidenceUnverifiableFailure)(
      yield* assemblePricingMaterialEvidence({
        ...materialRequest,
        ownerFenceRequest: {
          ...materialRequest.ownerFenceRequest,
          sources: [...materialRequest.ownerFenceRequest.sources, conflict],
        },
      }).pipe(Effect.flip),
    ),
  ).toBe(true);

  ordinals.length = 0;
  retireBeforeCandidateRead = true;
  const retiredRequest = requestFor(key, '2026-10-19T09:00:02.000Z');
  const retiredTrusted = {
    ...trusted,
    purchaseContextEvidence: {
      ...trusted.purchaseContextEvidence,
      currentness: {
        ...trusted.purchaseContextEvidence.currentness,
        evaluatedAt: retiredRequest.decision.operationTime,
        observedAt: retiredRequest.decision.operationTime,
      },
    },
  };
  const changed = yield* evaluation.evaluate(retiredRequest, retiredTrusted);
  expect(nativeRetirements).toBe(1);
  expect(ordinals).toEqual([1, 2]);
  expect(changed).toMatchObject({
    kind: 'NON_RESOLVED',
    outcome: { outcome: 'NO_APPLICABLE_PRICE' },
  });
  expect(changed).not.toHaveProperty('projection');
  expect(changed).not.toHaveProperty('commercialTotal');
  expect(changed).not.toHaveProperty('materialEvidence');
  const afterRetirement = yield* source.loadFresh(retiredRequest, retiredTrusted, 1);
  expect(Schema.is(ExactPriceAbsentResolutionSchema)(afterRetirement.exactPriceLines[0].exactPrice)).toBe(true);
  ordinals.length = 0;
  const persistentEmpty = yield* evaluation.evaluate(retiredRequest, retiredTrusted);
  expect(ordinals).toEqual([1]);
  expect(persistentEmpty).toMatchObject({ kind: 'NON_RESOLVED', outcome: { outcome: 'NO_APPLICABLE_PRICE' } });
});

it.live(
  'publishes stable native FOUND and preserves bounded no-money native ABSENT/change through the whole Pricing pipeline (#1279)',
  () =>
    withNativeCrypto(
      Effect.scoped(
        Effect.gen(function* nativeWholePricing1279() {
          const fixture = yield* makeNativeReadTestContext({
            contextPermissions: [],
            moduleId: 'commerce.pricing',
            ownerFixtureRetention: 'retain-complete-context',
          });
          const fixtureContext = yield* Layer.build(fixture.layer);
          yield* fixture.prepareOwner(nativeWhole1279).pipe(Effect.provideContext(fixtureContext));
        }),
      ),
    ),
);
