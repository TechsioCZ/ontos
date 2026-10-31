import { resolveCurrentSupportedCurrencies } from '../../src/api/current-supported-currencies.read.ts';
import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts/current-supported-currencies';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import { ExactPriceLookupFoundSchema } from '@app/pricing-contracts/domain/exact-price-lookup';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { PriceRevisionSchema } from '@app/pricing-contracts/domain/price-definition';
import { ScheduledPriceRevisionSchema } from '@app/pricing-contracts/domain/price-schedule';
import { QuantityTierSelectionSuccessSchema } from '@app/pricing-contracts/domain/quantity-tier';
import { PricingUnitPriceCalculationSuccessSchema } from '@app/pricing-contracts/domain/unit-price-calculation';
import type { PricingExactPriceOwnerReadReceipt } from '@app/pricing-contracts/domain/material-evidence';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import {
  defineRead,
  defineTenantModuleEntrypoint,
  ReadHandlerExecutionError,
  ReadHandlerUnavailable,
  findPostgresFailure,
  ScopedRoutineInvocationError,
} from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor, ReadHandlerContext } from '@app/core-runtime';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { PricingLineCompositionRequestSchema } from '@app/pricing-contracts/domain/line-composition';
import { PricingEvaluationAttemptSchema } from '@app/pricing-contracts/domain/material-change';
import { PricingCommercialFeeCalculationInputSchema } from '@app/pricing-contracts/domain/commercial-fee';
import { NodeCrypto } from '@effect/platform-node';
import { Context, Crypto, DateTime, Effect, Layer, Logger, Option, Schema } from 'effect';
import { SqlError, UnknownError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import {
  currentPricingDecisionWholeEvaluationAdaptersForScope,
  makeCurrentPricingDecisionWholeComposition,
} from '../../src/integrations/current-pricing-decision-whole-evaluation-adapters.ts';
import {
  CurrentPricingDecisionFeeSetReader,
  CurrentPricingDecisionOwnerReadFailure,
  makeCurrentPricingDecisionWholeEvaluationService,
} from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import type { CurrentPricingDecisionFeeSetReaderPort } from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import { makeCurrentPricingDecisionEvaluationService } from '../../src/services/current-pricing-decision-evaluation.service.ts';
import {
  commercialFeePersistenceForScope,
  verifyCommercialFeeSetGenerationRoutine,
} from '../../src/services/commercial-fee-persistence.service.ts';
import type {
  CommercialFeePersistence,
  DefineCommercialFeePersistenceCommand,
} from '../../src/services/commercial-fee-persistence.service.ts';
import { calculatePricingCommercialFees } from '../../src/services/commercial-fee-calculation.service.ts';
import {
  makePricingExternalOwnerEvidenceValidationService,
  PricingExternalOwnerEvidenceValidation,
} from '../../src/services/external-owner-evidence-validation.service.ts';
import { resolvePricingMaterialProofRoutine } from '../../src/services/material-evidence-proof-persistence.service.ts';
import { currencySupportPersistenceForScope } from '../../src/persistence/currency-support-persistence.ts';
import { pricePersistenceForScope } from '../../src/services/price-persistence.service.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';
import { makeIssue779Scenario } from '../unit/support/issue-779-line-value.fixture.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const FixtureValueSchema = Schema.Union([
  Schema.ObjectKeyword,
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Undefined,
]);
type FixtureValue = typeof FixtureValueSchema.Type;
const mapFixtureChildren = (
  value: FixtureValue,
  transform: (value: FixtureValue) => Effect.Effect<FixtureValue, Schema.SchemaError>,
): Effect.Effect<FixtureValue, Schema.SchemaError> => {
  if (Array.isArray(value)) {
    return Schema.decodeUnknownEffect(Schema.Array(FixtureValueSchema))(value).pipe(
      Effect.flatMap(Effect.forEach(transform)),
    );
  }
  if (Schema.is(Schema.ObjectKeyword)(value) && !DateTime.isDateTime(value)) {
    return Effect.forEach(Object.entries(value), ([field, child]) =>
      Schema.decodeUnknownEffect(FixtureValueSchema)(child).pipe(
        Effect.flatMap(transform),
        Effect.map((bound) => [field, bound] as const),
      ),
    ).pipe(Effect.map(Object.fromEntries));
  }
  return Effect.succeed(value);
};
const bindFixture = (
  value: FixtureValue,
  oldTenant: string,
  oldLegalEntity: string,
  scope: OperationalScope,
): Effect.Effect<FixtureValue, Schema.SchemaError> =>
  Schema.is(Schema.String)(value)
    ? Effect.succeed(
        value
          .replaceAll(oldTenant, scope.tenantId)
          .replaceAll(oldLegalEntity, scope.legalEntityId ?? 'missing-legal-entity'),
      )
    : mapFixtureChildren(value, (child) => bindFixture(child, oldTenant, oldLegalEntity, scope));

// Catalog, Tier, group and discount facts are explicit schema-validated preconditions.
// The Fee producer, its actual observation, immutable receipt, reader and calculator are real.
const scenarioFor = Effect.fn('test.nativeFeeScenario')(function* scenarioFor(scope: OperationalScope) {
  const fixture = yield* makeIssue779Scenario({ discounts: ['0', '0', '0'], feeAmount: '0' });
  const original = fixture.compositionRequest;
  const composition = yield* Schema.decodeEffect(PricingLineCompositionRequestSchema)(
    yield* bindFixture(
      original,
      original.decision.tenantId,
      original.decision.commercialScope.sellingLegalEntityId,
      scope,
    ),
  );
  const [unitPrice] = composition.unitPrices;
  if (unitPrice === undefined) {
    return yield* Effect.die('Native Fee fixture requires a unit-price precondition');
  }
  const { subject } = composition.decision.purchasingContext;
  const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
    decision: {
      ...composition.decision,
      purchasingContext: {
        ...composition.decision.purchasingContext,
        actor: { kind: 'PRINCIPAL', principalId: scope.principalId },
        subject,
      },
    },
    subject,
  });
  const at = request.decision.operationTime;
  const attempt = yield* Schema.decodeEffect(PricingEvaluationAttemptSchema)({
    attemptId: 'native-1242:attempt',
    attemptOrdinal: 1,
    candidateRef: composition.candidateRef,
    completedAt: at,
    maxAttempts: 2,
    runId: 'native-1242:run',
    snapshot: {
      attemptId: 'native-1242:attempt',
      calculationVersions: {
        allocationContractVersions: [],
        arithmeticProfileVersions: ['native-1242:precondition'],
        publicationProfileVersions: ['native-1242:precondition'],
      },
      candidateRef: composition.candidateRef,
      capturedAt: at,
      decision: request.decision,
      materialBindings: [
        {
          bindingRef: 'native-1242:upstream',
          kind: 'SUBJECT_OR_GUEST',
          meaningRef: 'native-1242:precondition',
          sourceEvidence: {
            _tag: 'UNVERIFIABLE',
            observedAt: at,
            reason: 'OWNER_UNAVAILABLE',
            request: {
              currencyCode: 'CZK',
              effectiveAt: at,
              family: 'COMMERCIAL_CONTEXT',
              ownerScope: {
                ownerModuleId: 'commerce.customer-context',
                ownerRootRef: 'native-1242:upstream',
                predicateRef: 'native-1242:upstream',
                tenantId: scope.tenantId,
              },
              requestedAt: at,
            },
            retryable: true,
          },
        },
      ],
      requestedAt: at,
      snapshotId: 'native-1242:snapshot',
    },
    startedAt: at,
  });
  const target = { variantRef: unitPrice.input.line.catalog.selection.variantRef };
  return {
    attempt,
    query: { commercialScope: request.decision.commercialScope, currencyCode: 'CZK', effectiveAt: at, target },
    request,
    unitPrice,
  };
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

const bindNativePrice = Effect.fn('test.nativeFeePricePrecondition')(function* bindNativePrice(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  scenario: Effect.Success<ReturnType<typeof scenarioFor>>,
) {
  const { path } = scenario.unitPrice.input.exactPrice;
  if (!('usedPrice' in path)) {
    return yield* Effect.die('Found Price precondition is required');
  }
  const old = path.usedPrice;
  const key = old.request.exactKey;
  const at = scenario.request.decision.operationTime;
  const money = old.priceRevision.monetaryAmount;
  const currencies = yield* currencySupportPersistenceForScope(transaction, scope, 'a'.repeat(64));
  expect(
    yield* currencies.setCurrent({
      ...(yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
        expectedState: { state: 'ABSENT' },
        intendedEffectivePeriod: { effectiveFrom: at, effectiveTo: null },
        intent: 'ESTABLISH_CURRENT',
        reason: 'Native Fee Currency support',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      })),
      actingPrincipalId: scope.principalId,
      actionInvocationId: yield* nextId,
      tenantId: scope.tenantId,
      trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(at)),
    }),
  ).toMatchObject({ outcome: 'CREATED' });
  const support = yield* resolveCurrentSupportedCurrencies(
    { effectiveAt: at, tenantId: scope.tenantId },
    { tenantId: scope.tenantId },
    currencies.loadCurrent,
  );
  if (!Schema.is(CurrentSupportedCurrenciesSuccessSchema)(support)) {
    return yield* Effect.die('Native Currency support must be Current');
  }
  const actionInvocationId = yield* nextId;
  const priceId = yield* nextId;
  const assertion = yield* Schema.decodeEffect(PriceSourceAssertionInputSchema)({
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'native-1242:mapping', mappingContractVersion: '1' },
    originalAssertion: { monetaryAmount: money, monetaryBoundary: 'PRE_TAX', unitBasis: key.unitBasis },
    sourceAssertionId: yield* nextId,
    sourceAuthority: { sourceAuthorityRef: 'native-1242:owner-source', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: actionInvocationId,
      sourceRecordRef: priceId,
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'native-1242:source' },
    },
    timing: { importedAt: at, ownerBusinessEffectiveAt: at, sourceEffectiveAt: at },
  });
  const prepared = preparePriceSourceEvidence({
    actingPrincipalId: scope.principalId,
    effectiveFrom: at,
    identityKey: key,
    monetaryAmount: money,
    sourceAssertion: assertion,
    tenantId: scope.tenantId,
    trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(at)),
  });
  if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
    return yield* Effect.die('Native Price source assertion is not ready');
  }
  const prices = yield* pricePersistenceForScope(transaction, scope);
  expect(
    yield* prices.define({
      actingPrincipalId: scope.principalId,
      actionInvocationId,
      effectiveFrom: at,
      identityKey: key,
      monetaryAmount: money,
      priceRef: {
        moduleId: 'commerce.pricing',
        resourceId: priceId,
        resourceType: 'commerce.pricing.price',
        tenantId: scope.tenantId,
      },
      reason: 'Native exact Price for whole Fee phase',
      requestCorrelationId: actionInvocationId,
      sourceEvidence: prepared.evidence,
      trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(at)),
    }),
  ).toMatchObject({ outcome: 'CREATED' });
  const current = yield* prices.exactLookup(old.request);
  const candidate = yield* prices.readExactCandidateSet(old.request);
  if (
    !Schema.is(ExactPriceLookupFoundSchema)(current) ||
    candidate.outcome !== 'EXACT_PRICE_CANDIDATE_SET_CURRENT' ||
    candidate.lookupEvidence === undefined
  ) {
    return yield* Effect.die('Native Price and candidate receipt are required');
  }
  const rebind = (value: FixtureValue): Effect.Effect<FixtureValue, Schema.SchemaError> =>
    Effect.gen(function* bindNativePriceValue() {
      if (Schema.is(CurrentSupportedCurrenciesSuccessSchema)(value)) {
        return support;
      }
      if (Schema.is(ExactPriceLookupFoundSchema)(value)) {
        return current;
      }
      if (Schema.is(QuantityTierSelectionSuccessSchema)(value) && value.outcome === 'BASE_PRICE_RETAINED') {
        const selected = yield* Schema.decodeUnknownEffect(Schema.toType(QuantityTierSelectionSuccessSchema))(value);
        return {
          ...selected,
          evidence: yield* rebind(value.evidence),
          resultingUnitPrice: current.priceRevision.monetaryAmount,
        };
      }
      if (
        Schema.is(ScheduledPriceRevisionSchema)(value) &&
        value.definition.revision.revisionId === old.priceRevision.revisionId
      ) {
        const scheduled = yield* Schema.decodeUnknownEffect(Schema.toType(ScheduledPriceRevisionSchema))(value);
        return {
          ...scheduled,
          definition: { ...value.definition, priceRef: current.priceRef, revision: current.priceRevision },
          effectivePeriod: { ...value.effectivePeriod, effectiveFrom: current.priceRevision.effectiveFrom },
        };
      }
      if (Schema.is(PriceRevisionSchema)(value) && value.revisionId === old.priceRevision.revisionId) {
        return current.priceRevision;
      }
      if (Schema.is(Schema.String)(value) && value === old.priceRef.resourceId) {
        return current.priceRef.resourceId;
      }
      if (Schema.is(Schema.String)(value) && value === old.priceRevision.revisionId) {
        return current.priceRevision.revisionId;
      }
      return yield* mapFixtureChildren(value, rebind);
    });
  const unitPrice = yield* Schema.decodeUnknownEffect(Schema.toType(PricingUnitPriceCalculationSuccessSchema))(
    yield* rebind(scenario.unitPrice),
  );
  const receipt = {
    authority: candidate.authority,
    factProofs: candidate.factProofs,
    lookupEvidence: candidate.lookupEvidence,
  } satisfies PricingExactPriceOwnerReadReceipt;
  return { receipt, scenario: { ...scenario, unitPrice } };
});

const feeCommandFor = Effect.fn('test.nativeFeeCommand')(function* feeCommandFor(
  scope: OperationalScope,
  scenario: Effect.Success<ReturnType<typeof scenarioFor>>,
  effectivePeriod?: DefineCommercialFeePersistenceCommand['effectivePeriod'],
) {
  const { query, unitPrice } = scenario;
  const { selection } = unitPrice.input.line.catalog;
  const actionInvocationId = yield* nextId;
  return {
    actingPrincipalId: scope.principalId,
    actionInvocationId,
    catalogTargetEvidence: {
      capturedAt: query.effectiveAt,
      catalogOwnerRevision: 'native-1242:declared-catalog-precondition',
      productRef: selection.productRef,
      snapshotId: 'native-1242:catalog-snapshot',
      targetId: 'native-1242:target',
      variantRef: selection.variantRef,
    },
    configuredAmount: { amount: '20', currencyCode: 'CZK' },
    effectivePeriod: effectivePeriod ?? { effectiveFrom: scenario.query.effectiveAt, effectiveTo: null },
    identityKey: {
      calculationBasis: { kind: 'FIXED_PER_LINE' },
      commercialScope: query.commercialScope,
      currencyCode: 'CZK',
      family: 'RECYCLING_FEE',
      monetaryBoundary: 'PRE_TAX',
      target: query.target,
    },
    reason: 'Native Fee observation regression',
    requestCorrelationId: actionInvocationId,
    trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(query.effectiveAt)),
  } satisfies DefineCommercialFeePersistenceCommand;
});

const withNativeOwner = <Value, Failure, Requirements>(
  operation: (
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
  ) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.scoped(
    Effect.gen(function* nativeOwnerBoundary() {
      const fixture = yield* makeNativeReadTestContext({
        contextPermissions: [],
        moduleId: 'commerce.pricing',
        ownerFixtureRetention: 'retain-complete-context',
      });
      const context = yield* Layer.build(fixture.layer);
      return yield* fixture.prepareOwner(operation).pipe(Effect.provideContext(context));
    }),
  );

const unexpected = () =>
  Effect.die('Publication or a later stage must not bypass the explicit Discount owner boundary');

const verifyWholeFeePhase = Effect.fn('test.nativeFeeWholePhase')(function* verifyWholeFeePhase(
  scenario: Effect.Success<ReturnType<typeof scenarioFor>>,
  reader: CurrentPricingDecisionFeeSetReaderPort,
  scope: OperationalScope,
  empty: boolean,
  priceReceipt: PricingExactPriceOwnerReadReceipt,
) {
  const { request, unitPrice } = scenario;
  const { subject } = request;
  if (subject.kind !== 'PROFILE') {
    return yield* Effect.die('Whole precondition requires the declared group Profile');
  }
  const purchaseContextEvidence = yield* Schema.decodeUnknownEffect(PricingPurchaseContextVerificationEvidenceSchema)({
    actingPrincipalId: scope.principalId,
    currentness: {
      evaluatedAt: request.decision.operationTime,
      observedAt: request.decision.operationTime,
      validFrom: request.decision.operationTime,
      validTo: null,
    },
    ownerRef: request.decision.purchasingContext.contextRef,
    ownerRevisionRef: request.decision.purchasingContext.contextRevision,
    subjectAuthority: {
      actorPrincipalId: scope.principalId,
      kind: 'PROFILE',
      partyAuthorityRef: 'native-1242:upstream-party',
      partyAuthorityRevisionRef: '1',
      subject,
      subjectAuthorityRef: 'native-1242:upstream-profile',
      subjectAuthorityRevisionRef: '1',
    },
    verificationRef: 'native-1242:declared-upstream-context',
    verifiedScope: {
      channelId: request.decision.commercialScope.channelId,
      legalEntityId: request.decision.commercialScope.sellingLegalEntityId,
      marketId: request.decision.commercialScope.marketId,
      tenantId: scope.tenantId,
    },
  });
  const { input } = unitPrice;
  const ordinals: number[] = [];
  const feeResults: unknown[] = [];
  const service = makeCurrentPricingDecisionWholeEvaluationService({
    attemptSource: {
      loadFresh: (_request, _trusted, ordinal) => {
        ordinals.push(ordinal);
        const attemptId = `native-1242:attempt:${ordinal}`;
        return Schema.decodeEffect(PricingEvaluationAttemptSchema)({
          ...scenario.attempt,
          attemptId,
          attemptOrdinal: ordinal,
          snapshot: { ...scenario.attempt.snapshot, attemptId, snapshotId: `native-1242:snapshot:${ordinal}` },
        }).pipe(
          Effect.mapError(
            () =>
              new CurrentPricingDecisionOwnerReadFailure({
                kind: 'UNVERIFIABLE',
                ownerRefs: ['native-1242:precondition'],
                reason: 'Invalid upstream fixture',
              }),
          ),
          Effect.map((attempt) => ({
            attempt,
            exactPriceLines: [
              {
                exactPrice: input.exactPrice,
                exactPriceInput: {
                  currencySupport: input.exactPrice.currencySupport,
                  resolutionInput: input.exactPrice.path.resolutionInput,
                },
                exactPriceTrustedContext: {
                  legalEntityId: request.decision.commercialScope.sellingLegalEntityId,
                  tenantId: scope.tenantId,
                  trustedOperationAt: DateTime.makeUnsafe(request.decision.operationTime),
                },
                line: input.line,
                lineQuantity: input.lineQuantity,
                priceCandidateSetAuthorities: [priceReceipt],
                quantityBasis: input.quantityBasis,
              },
            ] as const,
            requiredOwnerRefs: ['native-1242:discount-provider'] as const,
          })),
        );
      },
    },
    composition: makeCurrentPricingDecisionWholeComposition(),
    discountReader: {
      loadCurrent: ({ feeResults: results }) => {
        feeResults.push(...results);
        return Effect.fail(
          new CurrentPricingDecisionOwnerReadFailure({
            kind: 'UNAVAILABLE',
            ownerRefs: ['native-1242:discount-provider'],
            reason: 'Explicit downstream provider boundary after real Fee calculation',
          }),
        );
      },
    },
    externalOwnerEvidence: { loadFresh: unexpected },
    feeReader: reader,
    floorReader: { loadCurrent: unexpected },
    promotionEvaluation: { evaluate: unexpected },
    tierReader: {
      loadCurrent: () =>
        Effect.succeed({
          authority: {
            generation: 1,
            observedAt: request.decision.operationTime,
            ownerRevision: 'native-1242:declared-tier',
            ownerRootRef: 'native-1242:declared-tier',
            predicateRef: 'native-1242:declared-tier',
            verificationRef: 'native-1242:declared-tier',
          },
          request: { input: input.tierSelection.evidence.input, outcome: 'TIER_SET_CURRENT' as const },
        }),
    },
  });
  const evaluation = makeCurrentPricingDecisionEvaluationService(service, unexpected);
  const result = yield* evaluation.evaluate(request, {
    purchaseContextEvidence,
    sellingLegalEntityId: request.decision.commercialScope.sellingLegalEntityId,
    tenantId: scope.tenantId,
  });
  expect(ordinals).toEqual([1, 2]);
  expect(feeResults).toHaveLength(2);
  for (const feeResult of feeResults) {
    expect(feeResult).toMatchObject({
      contributionTotal: { amount: empty ? '0' : '20', currencyCode: 'CZK' },
      outcome: 'COMMERCIAL_FEES_APPLIED',
    });
  }
  expect(result).toMatchObject({
    kind: 'NON_RESOLVED',
    outcome: {
      inabilityEvidence: { attempts: 2, requiredOwnerRefs: ['native-1242:discount-provider'] },
      outcome: 'PRICING_INDETERMINATE',
      reasonCode: 'OWNER_STATE_UNAVAILABLE',
    },
  });
  // This proves whole Fee/retry execution with explicit upstream preconditions, not a full public route.
  return yield* Effect.void;
});

it.live(
  'accepts native nonempty/proven-empty O>T through the production reader and original generation witness (#1242)',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeFeeObservedTime() {
        for (const empty of [false, true]) {
          const fixture = yield* makeNativeReadTestContext({
            contextPermissions: [],
            moduleId: 'commerce.pricing',
            ownerFixtureRetention: 'retain-complete-context',
          });
          const fixtureContext = yield* Layer.build(fixture.layer);
          yield* fixture
            .prepareOwner(
              Effect.fn('test.nativeFeeProducerAndConsumer')(
                function* nativeFeeProducerAndConsumer(transaction, scope) {
                  const { receipt, scenario } = yield* bindNativePrice(transaction, scope, yield* scenarioFor(scope));
                  const persistence = yield* commercialFeePersistenceForScope(transaction, scope);
                  const { query, request, unitPrice } = scenario;
                  const command = yield* feeCommandFor(scope, scenario, {
                    effectiveFrom: empty ? '2099-01-01T00:00:00.000Z' : query.effectiveAt,
                    effectiveTo: null,
                  });
                  expect(yield* persistence.define(command)).toMatchObject({ outcome: 'COMMERCIAL_FEE_CREATED' });
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
                  const reader = Context.get(context, CurrentPricingDecisionFeeSetReader);
                  const read = yield* reader.loadCurrent(request, scenario.attempt, unitPrice);
                  expect(read.authority.observedAt > query.effectiveAt).toBe(true);
                  expect(read.input.decision.operationTime).toBe(query.effectiveAt);
                  expect(read.input.feeSet.observedAt).toBe(read.authority.observedAt);
                  const input = yield* Schema.decodeEffect(PricingCommercialFeeCalculationInputSchema)(read.input);
                  const result = yield* calculatePricingCommercialFees(input);
                  expect(result).toMatchObject({
                    contributionTotal: { amount: empty ? '0' : '20', currencyCode: 'CZK' },
                    discountableLineBasis: { amount: empty ? '100' : '120', currencyCode: 'CZK' },
                    outcome: 'COMMERCIAL_FEES_APPLIED',
                  });
                  const receipts = yield* transaction.invoke(resolvePricingMaterialProofRoutine, [
                    {
                      evidenceObservedAt: read.authority.observedAt,
                      evidenceVerificationRef: read.authority.verificationRef,
                      expectedFacts: read.factProofs,
                      family: 'COMMERCIAL_FEE',
                      ownerRootRef: read.authority.ownerRootRef,
                      ownerSetRevisionRef: read.authority.ownerRevision,
                      predicateRef: read.authority.predicateRef,
                      query,
                    },
                  ]);
                  expect(receipts).toHaveLength(1);
                  yield* verifyWholeFeePhase(scenario, reader, scope, empty, receipt);
                  // A later native statement fixes an honest through instant after the original observation.
                  const later = yield* persistence.readCurrentSet(query);
                  if (later.outcome !== 'COMMERCIAL_FEE_SET_CURRENT') {
                    return yield* Effect.die('Expected stable native Current Fee set');
                  }
                  expect(
                    yield* persistence.verifySetGeneration({
                      ...query,
                      authority: read.authority,
                      through: later.authority.observedAt,
                    }),
                  ).toMatchObject({ outcome: 'COMMERCIAL_FEE_SET_GENERATION_CURRENT' });
                  return yield* Effect.void;
                },
              ),
            )
            .pipe(Effect.provideContext(fixtureContext));
        }
      }),
    ).pipe(withNativeCrypto),
);

it.live('keeps missing authority and crossed start/end boundaries unverifiable (#1242)', () =>
  Effect.gen(function* actualFeeBoundaryControls() {
    for (const ending of [false, true]) {
      yield* withNativeOwner(
        Effect.fn('test.nativeFeeBoundary')(function* nativeFeeBoundary(transaction, scope) {
          const scenario = yield* scenarioFor(scope);
          const persistence = yield* commercialFeePersistenceForScope(transaction, scope);
          expect(yield* persistence.readCurrentSet(scenario.query)).toEqual({ outcome: 'COMMERCIAL_FEE_SET_MISSING' });
          const boundary = DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(scenario.query.effectiveAt), { milliseconds: 1 }),
          );
          const command = yield* feeCommandFor(
            scope,
            scenario,
            ending
              ? { effectiveFrom: scenario.query.effectiveAt, effectiveTo: boundary }
              : { effectiveFrom: boundary, effectiveTo: null },
          );
          expect(yield* persistence.define(command)).toMatchObject({ outcome: 'COMMERCIAL_FEE_CREATED' });
          expect(yield* persistence.readCurrentSet(scenario.query)).toMatchObject({
            outcome: 'COMMERCIAL_FEE_SET_UNVERIFIABLE',
          });
        }),
      );
    }
  }).pipe(withNativeCrypto),
);

it.live('rejects forged authority and native material insertion/revision/retirement at final validation (#1242)', () =>
  withNativeOwner(
    Effect.fn('test.nativeFeeMaterialChanges')(function* nativeFeeMaterialChanges(transaction, scope) {
      const scenario = yield* scenarioFor(scope);
      const { query } = scenario;
      const persistence = yield* commercialFeePersistenceForScope(transaction, scope);
      const command = yield* feeCommandFor(scope, scenario);
      expect(yield* persistence.define(command)).toMatchObject({ outcome: 'COMMERCIAL_FEE_CREATED' });
      const original = yield* persistence.readCurrentSet(query);
      const later = yield* persistence.readCurrentSet(query);
      if (original.outcome !== 'COMMERCIAL_FEE_SET_CURRENT' || later.outcome !== 'COMMERCIAL_FEE_SET_CURRENT') {
        return yield* Effect.die('Native Fee proof precondition is missing');
      }
      const through = later.authority.observedAt;
      for (const authority of [
        { ...original.authority, ownerRootRef: 'foreign-root' },
        { ...original.authority, ownerRevision: 'foreign-revision' },
        { ...original.authority, predicateRef: 'foreign-predicate' },
        { ...original.authority, verificationRef: 'foreign-verification' },
        { ...original.authority, generation: original.authority.generation + 1 },
        { ...original.authority, nextApplicabilityBoundary: '2099-01-01T00:00:00.000Z' },
      ]) {
        expect(yield* persistence.verifySetGeneration({ ...query, authority, through })).toMatchObject({
          outcome: 'COMMERCIAL_FEE_SET_GENERATION_CHANGED',
        });
      }
      const insertionId = yield* nextId;
      expect(
        yield* persistence.define({
          ...command,
          actionInvocationId: insertionId,
          identityKey: { ...command.identityKey, family: 'COPYRIGHT_FEE' },
          requestCorrelationId: insertionId,
        }),
      ).toMatchObject({ outcome: 'COMMERCIAL_FEE_CREATED' });
      expect(
        yield* persistence.verifySetGeneration({ ...query, authority: original.authority, through }),
      ).toMatchObject({ outcome: 'COMMERCIAL_FEE_SET_GENERATION_CHANGED' });
      const beforeRevision = yield* persistence.readCurrentSet(query);
      const schedule = yield* persistence.readSchedule({
        identityKey: command.identityKey,
        trustedOperationAt: command.trustedOperationAt,
      });
      if (
        beforeRevision.outcome !== 'COMMERCIAL_FEE_SET_CURRENT' ||
        schedule.outcome !== 'COMMERCIAL_FEE_SCHEDULE' ||
        schedule.schedule.current === undefined
      ) {
        return yield* Effect.die('Native Fee revision precondition is missing');
      }
      const { current } = schedule.schedule;
      const revisedAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(query.effectiveAt), { milliseconds: 1 }));
      const revisionId = yield* nextId;
      const revised = yield* persistence.revise({
        actingPrincipalId: scope.principalId,
        actionInvocationId: revisionId,
        catalogTargetEvidence: command.catalogTargetEvidence,
        configuredAmount: { amount: '21', currencyCode: 'CZK' },
        effectiveFrom: revisedAt,
        expectedCurrent: {
          effectivePeriod: current.effectivePeriod,
          feeRef: current.definition.feeRef,
          identityKey: command.identityKey,
          revision: current.definition.revision.revision,
          revisionId: current.definition.revision.revisionId,
          scheduleRevision: schedule.schedule.scheduleRevision,
        },
        identityKey: command.identityKey,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Native material revision',
        requestCorrelationId: revisionId,
        trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(revisedAt)),
      });
      expect(revised).toMatchObject({ outcome: 'COMMERCIAL_FEE_REVISED' });
      expect(
        yield* persistence.verifySetGeneration({
          ...query,
          authority: beforeRevision.authority,
          through: beforeRevision.authority.observedAt,
        }),
      ).toMatchObject({ outcome: 'COMMERCIAL_FEE_SET_GENERATION_CHANGED' });
      if (revised.outcome !== 'COMMERCIAL_FEE_REVISED' || revised.schedule.current === undefined) {
        return yield* Effect.die('Native revised Fee current precondition is missing');
      }
      const active = revised.schedule.current;
      const retireAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(revisedAt), { milliseconds: 1 }));
      const retireId = yield* nextId;
      const retirementQuery = { ...query, effectiveAt: revisedAt };
      const beforeRetirement = yield* persistence.readCurrentSet(retirementQuery);
      if (beforeRetirement.outcome !== 'COMMERCIAL_FEE_SET_CURRENT') {
        return yield* Effect.die('Expected revised native Current Fee set');
      }
      expect(
        yield* persistence.revise({
          actingPrincipalId: scope.principalId,
          actionInvocationId: retireId,
          effectiveTo: retireAt,
          expectedCurrent: {
            effectivePeriod: active.effectivePeriod,
            feeRef: active.definition.feeRef,
            identityKey: command.identityKey,
            revision: active.definition.revision.revision,
            revisionId: active.definition.revision.revisionId,
            scheduleRevision: revised.schedule.scheduleRevision,
          },
          identityKey: command.identityKey,
          intent: 'RETIRE_CURRENT',
          reason: 'Native material retirement',
          requestCorrelationId: retireId,
          trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(revisedAt)),
        }),
      ).toMatchObject({ outcome: 'COMMERCIAL_FEE_REVISED' });
      expect(
        yield* persistence.verifySetGeneration({
          ...retirementQuery,
          authority: beforeRetirement.authority,
          through: beforeRetirement.authority.observedAt,
        }),
      ).toMatchObject({ outcome: 'COMMERCIAL_FEE_SET_GENERATION_CHANGED' });
      return yield* Effect.void;
    }),
  ).pipe(withNativeCrypto),
);

it.live('rejects invalid native observation/through intervals without committing a pseudo-success (#1242)', () =>
  Effect.gen(function* nativeFeeIntervalControls() {
    for (const invalid of [
      'missing-effective',
      'missing-observed',
      'missing-through',
      'observation-before-T',
      'through-before-observation',
      'future-through',
    ]) {
      const failure = yield* withNativeOwner(
        Effect.fn('test.nativeFeeInvalidInterval')(function* nativeFeeInvalidInterval(transaction, scope) {
          const scenario = yield* scenarioFor(scope);
          const persistence = yield* commercialFeePersistenceForScope(transaction, scope);
          expect(yield* persistence.define(yield* feeCommandFor(scope, scenario))).toMatchObject({
            outcome: 'COMMERCIAL_FEE_CREATED',
          });
          const original = yield* persistence.readCurrentSet(scenario.query);
          if (original.outcome !== 'COMMERCIAL_FEE_SET_CURRENT') {
            return yield* Effect.die('Expected real native original Fee authority');
          }
          const future = DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(original.authority.observedAt), { hours: 1 }),
          );
          let observedAt: string | null = original.authority.observedAt;
          if (invalid === 'missing-observed') {
            observedAt = null;
          } else if (invalid === 'observation-before-T') {
            observedAt = DateTime.formatIso(
              DateTime.subtract(DateTime.makeUnsafe(scenario.query.effectiveAt), { milliseconds: 1 }),
            );
          }
          let through: string | null = original.authority.observedAt;
          if (invalid === 'missing-through') {
            through = null;
          } else if (invalid === 'through-before-observation') {
            through = scenario.query.effectiveAt;
          } else if (invalid === 'future-through') {
            through = future;
          }
          return yield* transaction.invoke(verifyCommercialFeeSetGenerationRoutine, [
            {
              ...scenario.query,
              authority: { ...original.authority, observedAt },
              effectiveAt: invalid === 'missing-effective' ? null : scenario.query.effectiveAt,
              through,
            },
          ]);
        }),
      ).pipe(Effect.flip);
      expect(
        Schema.is(ScopedRoutineInvocationError)(failure)
          ? Option.getOrUndefined(failure.postgresCode)
          : findPostgresFailure(failure).pipe(
              Option.map(({ code }) => code),
              Option.getOrUndefined,
            ),
      ).toBe('22023');
    }
  }).pipe(withNativeCrypto),
);

interface NativeFeeReadServices {
  readonly persistence: CommercialFeePersistence;
  readonly reader: CurrentPricingDecisionFeeSetReaderPort;
}
const provisionalReads: {
  readonly query: Effect.Success<ReturnType<typeof scenarioFor>>['query'];
  readonly read: Effect.Success<ReturnType<CurrentPricingDecisionFeeSetReaderPort['loadCurrent']>>;
}[] = [];
const nativeFeeRead = defineRead(
  {
    accessKind: 'detail',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'pricing.commercial_fee.native_test.read' },
      entrypointKey: 'commerce.pricing.test.fee-observed-time',
      moduleKey: 'commerce.pricing',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'commerce.pricing.test.fee-observed-time.evidence.v1' },
    inputSchema: Schema.Struct({
      attempt: PricingEvaluationAttemptSchema,
      invalidInterval: Schema.Boolean,
      request: CurrentPricingDecisionRequestSchema,
      unitPrice: Schema.toType(PricingUnitPriceCalculationSuccessSchema),
    }),
    legalEntityScope: 'required',
    owningModuleKey: 'commerce.pricing',
    permissionTarget: 'module',
    policies: [],
    readKey: 'commerce.pricing.test.fee-observed-time',
    resultSchema: Schema.Struct({ outcome: Schema.String }),
    schemaVersion: '1',
  },
  (input, context: ReadHandlerContext<NativeFeeReadServices>) =>
    Effect.gen(function* localGovernedFeeHandler() {
      const read = yield* context.services.reader.loadCurrent(input.request, input.attempt, input.unitPrice);
      const result = yield* calculatePricingCommercialFees(read.input);
      if (input.invalidInterval) {
        const query = {
          commercialScope: input.request.decision.commercialScope,
          currencyCode: input.request.decision.currencyCode,
          effectiveAt: input.request.decision.operationTime,
          target: { variantRef: input.unitPrice.input.line.catalog.selection.variantRef },
        };
        provisionalReads.push({ query, read });
        yield* context.services.persistence
          .verifySetGeneration({ ...query, authority: read.authority, through: query.effectiveAt })
          .pipe(Effect.catchTag('CommercialFeePersistenceUnavailable', () => Effect.void));
      }
      return { evidence: { resultCount: 1 }, result: { outcome: result.outcome } };
    }).pipe(
      Effect.mapError(
        () =>
          new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: 'Native Commercial Fee owner unavailable',
          }),
      ),
    ),
  (transaction, scope) =>
    Effect.gen(function* nativeFeeReadServices() {
      const persistence = yield* commercialFeePersistenceForScope(transaction, scope);
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
      return { persistence, reader: Context.get(context, CurrentPricingDecisionFeeSetReader) };
    }),
  () => ({ kind: 'module', moduleId: 'commerce.pricing' }),
);

it.live('settles real Core Fee evidence and rolls back a SQL-aborted pseudo-success (#1242)', () =>
  Effect.scoped(
    Effect.gen(function* governedNativeFee() {
      const fixture = yield* makeNativeReadTestContext({
        contextPermissions: ['pricing.commercial_fee.native_test.read'],
        moduleId: 'commerce.pricing',
        ownerFixtureRetention: 'retain-complete-context',
      });
      const context = yield* Layer.build(fixture.layer);
      const scenario = yield* fixture
        .prepareOwner(
          Effect.fn('test.prepareGovernedFee')(function* prepareGovernedFee(transaction, scope) {
            const { scenario: preparedScenario } = yield* bindNativePrice(
              transaction,
              scope,
              yield* scenarioFor(scope),
            );
            const persistence = yield* commercialFeePersistenceForScope(transaction, scope);
            expect(yield* persistence.define(yield* feeCommandFor(scope, preparedScenario))).toMatchObject({
              outcome: 'COMMERCIAL_FEE_CREATED',
            });
            return preparedScenario;
          }),
        )
        .pipe(Effect.provideContext(context));
      const before = yield* fixture.evidenceCount();
      const invoke = (invalidInterval: boolean) =>
        fixture.runtime.runRead({
          input: {
            attempt: scenario.attempt,
            invalidInterval,
            request: scenario.request,
            unitPrice: scenario.unitPrice,
          },
          principal: fixture.principal,
          registration: nativeFeeRead,
          transport: { correlationId: 'native-1242:governed' },
        });
      expect(yield* invoke(false).pipe(Effect.provideContext(context))).toEqual({ outcome: 'COMMERCIAL_FEES_APPLIED' });
      expect(yield* fixture.evidenceCount()).toBe(before + 1);
      provisionalReads.length = 0;
      const logLevels: string[] = [];
      const loggerContext = yield* Layer.build(
        Logger.layer([
          Logger.make((entry) => {
            logLevels.push(entry.logLevel);
          }),
        ]),
      );
      const failure = yield* invoke(true).pipe(
        Effect.provideContext(Context.merge(context, loggerContext)),
        Effect.flip,
      );
      // The split Read lifecycle settles the owner transaction before its evidence transaction.
      // An aborted owner transaction must therefore fail before evidence persistence even begins.
      expect(Schema.is(ReadHandlerExecutionError)(failure)).toBe(true);
      expect(failure).toMatchObject({
        code: 'read_handler_execution_failed',
        reason: 'The governed read transaction failed',
      });
      const settlement = yield* Schema.decodeUnknownEffect(Schema.Struct({ cause: Schema.toType(SqlError) }))(failure);
      // No evidence INSERT is attempted after this failed COMMIT, so PostgreSQL does not emit 25P02 here.
      // The native driver's checked COMMIT must instead retain its exact aborted-transaction failure.
      expect(Schema.is(UnknownError)(settlement.cause.reason)).toBe(true);
      expect(settlement.cause.reason).toMatchObject({
        message: 'PgClient: COMMIT rolled back an aborted transaction',
        operation: 'commit',
      });
      expect(logLevels).toEqual(['Error']);
      expect(yield* fixture.evidenceCount()).toBe(before + 1);
      const [provisional] = provisionalReads;
      if (provisional === undefined) {
        return yield* Effect.die('Expected a real provisional Fee receipt');
      }
      expect(
        yield* fixture
          .prepareOwner((transaction) =>
            transaction.invoke(resolvePricingMaterialProofRoutine, [
              {
                evidenceObservedAt: provisional.read.authority.observedAt,
                evidenceVerificationRef: provisional.read.authority.verificationRef,
                expectedFacts: provisional.read.factProofs,
                family: 'COMMERCIAL_FEE',
                ownerRootRef: provisional.read.authority.ownerRootRef,
                ownerSetRevisionRef: provisional.read.authority.ownerRevision,
                predicateRef: provisional.read.authority.predicateRef,
                query: provisional.query,
              },
            ]),
          )
          .pipe(Effect.provideContext(context)),
      ).toHaveLength(0);
      expect(yield* invoke(false).pipe(Effect.provideContext(context))).toEqual({ outcome: 'COMMERCIAL_FEES_APPLIED' });
      expect(yield* fixture.evidenceCount()).toBe(before + 2);
      const denied = yield* makeNativeReadTestContext({
        contextPermissions: [],
        moduleId: 'commerce.pricing',
        ownerFixtureRetention: 'retain-complete-context',
      });
      const deniedContext = yield* Layer.build(denied.layer);
      expect(
        yield* denied.runtime
          .runRead({
            input: {
              attempt: scenario.attempt,
              invalidInterval: false,
              request: scenario.request,
              unitPrice: scenario.unitPrice,
            },
            principal: denied.principal,
            registration: nativeFeeRead,
            transport: { correlationId: 'native-1242:denied' },
          })
          .pipe(Effect.provideContext(deniedContext), Effect.flip),
      ).toMatchObject({ code: 'read_permission_denied' });
      return yield* Effect.void;
    }),
  ).pipe(withNativeCrypto),
);
