import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import type { OperationalScope, ScopedTransactionExecutor, ReadHandlerContext } from '@app/core-runtime';
import {
  defineRead,
  defineTenantModuleEntrypoint,
  findPostgresFailure,
  ReadHandlerExecutionError,
  ReadHandlerUnavailable,
  ScopedRoutineInvocationError,
} from '@app/core-runtime';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { PricingRawCompositionReadySchema } from '@app/pricing-contracts/domain/line-composition';
import {
  PricingInstantSchema,
  SetSupportedCurrenciesV2PayloadSchema,
} from '@app/pricing-contracts/domain/currency-support';
import { PricingMaterialEvidenceFenceSourceSchema } from '@app/pricing-contracts/domain/material-evidence';
import { PricingEvaluationAttemptSchema } from '@app/pricing-contracts/domain/material-change';
import type { PricingZeroFloorAuthorizationQuery } from '@app/pricing-contracts/domain/line-composition';
import { PriceRevisionSchema } from '@app/pricing-contracts/domain/price-definition';
import { QuantityTierSelectionSuccessSchema } from '@app/pricing-contracts/domain/quantity-tier';
import { ScheduledPriceRevisionSchema } from '@app/pricing-contracts/domain/price-schedule';
import { ExactPriceLookupFoundSchema } from '@app/pricing-contracts/domain/exact-price-lookup';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { NodeCrypto } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { zeroFloorSetHeads } from '../../src/database/schema.ts';
import { Clock, Context, Crypto, DateTime, Duration, Effect, Layer, Logger, Option, Schema } from 'effect';
import { SqlError, UnknownError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { makeCurrentPricingDecisionZeroFloorSetReader } from '../../src/integrations/current-pricing-decision-whole-evaluation-adapters.ts';
import type { ZeroFloorAuthorizationPersistence } from '../../src/services/zero-floor-authorization-persistence.service.ts';
import {
  materialEvidenceProofPersistenceForScope,
  resolvePricingMaterialProofRoutine,
} from '../../src/services/material-evidence-proof-persistence.service.ts';
import { makePricingCurrentDecisionPricingOwnerFinalFenceGateway } from '../../src/integrations/current-pricing-decision-owner-final-fence.ts';
import { PricingOwnerMaterialEvidenceFenceGatewayUnavailable } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import {
  zeroFloorAuthorizationPersistenceForScope,
  readCurrentZeroFloorAuthorizationSetRoutine,
  readCurrentZeroFloorAuthorizationGovernanceProofRoutine,
  readCurrentZeroFloorAuthorizationSetForQueryRoutine,
} from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { pricePersistenceForScope } from '../../src/services/price-persistence.service.ts';
import { currencySupportPersistenceForScope } from '../../src/persistence/currency-support-persistence.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';
import { composePricingRawLines } from '../../src/services/line-value-composition.service.ts';
import { evaluatePricingLineValues } from '../../src/services/line-value-calculation.service.ts';
import {
  authorizationSetFor,
  firstRawLine,
  makeIssue779Scenario,
} from '../unit/support/issue-779-line-value.fixture.ts';

const FixtureValueSchema = Schema.Union([
  Schema.ObjectKeyword,
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Undefined,
]);
type FixtureValue = typeof FixtureValueSchema.Type;
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

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

const withNativeCrypto = <Value, Failure, Requirements>(
  program: Effect.Effect<Value, Failure, Requirements | Crypto.Crypto>,
) =>
  Effect.scoped(
    Effect.gen(function* nativeCryptoBoundary() {
      const context = yield* Layer.build(NodeCrypto.layer);
      return yield* program.pipe(Effect.provideContext(context));
    }),
  );

const produceNativePrice = Effect.fn('test.produceNativeFloorPrice')(function* produceNativePrice(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  composition: typeof PricingRawCompositionReadySchema.Type,
) {
  const line = firstRawLine(composition.lines);
  const { path } = line.unitPriceCalculation.input.exactPrice;
  if (!('usedPrice' in path)) {
    return yield* Effect.die('Expected found exact Price precondition');
  }
  const { priceRevision: oldRevision, request: lookupRequest } = path.usedPrice;
  const key = lookupRequest.exactKey;
  const { operationTime } = composition.decision;
  const money = oldRevision.monetaryAmount;
  const currencies = yield* currencySupportPersistenceForScope(transaction, scope, 'a'.repeat(64));
  const support = yield* currencies.setCurrent({
    ...(yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
      expectedState: { state: 'ABSENT' },
      intendedEffectivePeriod: { effectiveFrom: operationTime, effectiveTo: null },
      intent: 'ESTABLISH_CURRENT',
      reason: 'Native floor predicate Currency support',
      schemaVersion: '2',
      supportedCurrencies: ['CZK'],
    })),
    actingPrincipalId: scope.principalId,
    actionInvocationId: yield* nextId,
    tenantId: scope.tenantId,
    trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
  });
  expect(support.outcome).toBe('CREATED');
  const actionInvocationId = yield* nextId;
  const priceId = yield* nextId;
  const assertion = yield* Schema.decodeEffect(PriceSourceAssertionInputSchema)({
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'native-1277:mapping', mappingContractVersion: '1' },
    originalAssertion: { monetaryAmount: money, monetaryBoundary: 'PRE_TAX', unitBasis: key.unitBasis },
    sourceAssertionId: yield* nextId,
    sourceAuthority: { sourceAuthorityRef: 'native-1277:owner-source', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: actionInvocationId,
      sourceRecordRef: priceId,
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'native-1277:source' },
    },
    timing: { importedAt: operationTime, ownerBusinessEffectiveAt: operationTime, sourceEffectiveAt: operationTime },
  });
  const prepared = preparePriceSourceEvidence({
    actingPrincipalId: scope.principalId,
    effectiveFrom: operationTime,
    identityKey: key,
    monetaryAmount: money,
    sourceAssertion: assertion,
    tenantId: scope.tenantId,
    trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
  });
  if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
    return yield* Effect.die('Native Price assertion not ready');
  }
  const prices = yield* pricePersistenceForScope(transaction, scope);
  expect(
    yield* prices.define({
      actingPrincipalId: scope.principalId,
      actionInvocationId,
      effectiveFrom: operationTime,
      identityKey: key,
      monetaryAmount: money,
      priceRef: {
        moduleId: 'commerce.pricing',
        resourceId: priceId,
        resourceType: 'commerce.pricing.price',
        tenantId: scope.tenantId,
      },
      reason: 'Native Price for floor query',
      requestCorrelationId: actionInvocationId,
      sourceEvidence: prepared.evidence,
      trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
    }),
  ).toMatchObject({ outcome: 'CREATED' });
  const current = yield* prices.exactLookup(lookupRequest);
  if (!Schema.is(ExactPriceLookupFoundSchema)(current)) {
    return yield* Effect.die('Native Price producer must be FOUND');
  }
  const bindNativePrice = (value: FixtureValue): Effect.Effect<FixtureValue, Schema.SchemaError> =>
    Effect.gen(function* bindNativePriceValue() {
      if (Schema.is(ExactPriceLookupFoundSchema)(value)) {
        return current;
      }
      if (Schema.is(QuantityTierSelectionSuccessSchema)(value) && value.outcome === 'BASE_PRICE_RETAINED') {
        const selected = yield* Schema.decodeUnknownEffect(Schema.toType(QuantityTierSelectionSuccessSchema))(value);
        return {
          ...selected,
          evidence: yield* bindNativePrice(value.evidence),
          resultingUnitPrice: current.priceRevision.monetaryAmount,
        };
      }
      if (
        Schema.is(ScheduledPriceRevisionSchema)(value) &&
        value.definition.revision.revisionId === oldRevision.revisionId
      ) {
        const scheduled = yield* Schema.decodeUnknownEffect(Schema.toType(ScheduledPriceRevisionSchema))(value);
        return {
          ...scheduled,
          definition: { ...value.definition, priceRef: current.priceRef, revision: current.priceRevision },
          effectivePeriod: { ...value.effectivePeriod, effectiveFrom: current.priceRevision.effectiveFrom },
        };
      }
      if (Schema.is(PriceRevisionSchema)(value) && value.revisionId === oldRevision.revisionId) {
        return current.priceRevision;
      }
      if (Schema.is(Schema.String)(value) && value === path.usedPrice.priceRef.resourceId) {
        return current.priceRef.resourceId;
      }
      if (Schema.is(Schema.String)(value) && value === oldRevision.revisionId) {
        return current.priceRevision.revisionId;
      }
      return yield* mapFixtureChildren(value, bindNativePrice);
    });
  return yield* Schema.decodeEffect(PricingRawCompositionReadySchema)(yield* bindNativePrice(composition));
});

// Upstream Catalog/discount composition is a schema-validated precondition here.
// Currency support and exact Price come from actual native owner producers.
// The producer under test is the actual governed native ZERO_FLOOR approval/create path.
const compositionFor = Effect.fn('test.nativeFloorComposition')(function* compositionFor(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  priceAmount = '100',
  discounts: readonly [string, string, string] = ['0', '0', '0'],
) {
  const fixture = yield* makeIssue779Scenario({ discounts, priceAmount });
  const raw = yield* composePricingRawLines(fixture.compositionRequest);
  if (raw.outcome !== 'RAW_COMPOSITION_READY') {
    return yield* Effect.die('Expected raw composition fixture');
  }
  const originalTenant = raw.decision.tenantId;
  const originalLegalEntity = raw.decision.commercialScope.sellingLegalEntityId;
  const rebind = (value: FixtureValue): Effect.Effect<FixtureValue, Schema.SchemaError> =>
    Effect.gen(function* rebindFixtureValue() {
      if (Schema.is(Schema.String)(value)) {
        return value
          .replaceAll(originalTenant, scope.tenantId)
          .replaceAll(originalLegalEntity, scope.legalEntityId ?? 'missing-legal-entity');
      }
      return yield* mapFixtureChildren(value, rebind);
    });
  const scoped = yield* Schema.decodeEffect(PricingRawCompositionReadySchema)(yield* rebind(raw));
  return yield* produceNativePrice(transaction, scope, scoped);
});

type Composition = typeof PricingRawCompositionReadySchema.Type;

const readFloor = Effect.fn('test.actualNativeFloorReader')(function* readFloor(
  persistence: ZeroFloorAuthorizationPersistence,
  composition: Composition,
) {
  const subject = {
    guestEvidenceRef: 'native-1277:guest',
    guestSessionRef: 'native-1277:session',
    kind: 'GUEST' as const,
  };
  const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
    decision: {
      ...composition.decision,
      purchasingContext: { ...composition.decision.purchasingContext, actor: subject, subject },
    },
    subject,
  });
  const boundComposition = { ...composition, decision: request.decision };
  const reader = makeCurrentPricingDecisionZeroFloorSetReader(persistence);
  // SAFETY: The production floor reader does not inspect its attempt parameter. This
  // owner-local test does not claim to produce a full prior whole-evaluation snapshot.
  const { path } = firstRawLine(composition.lines).unitPriceCalculation.input.exactPrice;
  if (!('usedPrice' in path)) {
    return yield* Effect.die('Native exact Price observation required');
  }
  const { observedAt } = path.usedPrice.evidence;
  const attempt = yield* Schema.decodeUnknownEffect(PricingEvaluationAttemptSchema)({
    attemptId: 'native-1277:unused-attempt',
    attemptOrdinal: 1,
    candidateRef: composition.candidateRef,
    completedAt: observedAt,
    maxAttempts: 2,
    runId: 'native-1277:unused-run',
    snapshot: {
      attemptId: 'native-1277:unused-attempt',
      calculationVersions: {
        allocationContractVersions: [],
        arithmeticProfileVersions: ['native-1277:precondition'],
        publicationProfileVersions: ['native-1277:precondition'],
      },
      candidateRef: composition.candidateRef,
      capturedAt: observedAt,
      decision: request.decision,
      materialBindings: [
        {
          bindingRef: 'native-1277:unverified-context',
          kind: 'SUBJECT_OR_GUEST',
          meaningRef: 'native-1277:upstream-precondition',
          sourceEvidence: {
            _tag: 'UNVERIFIABLE',
            observedAt,
            reason: 'OWNER_UNAVAILABLE',
            request: {
              effectiveAt: request.decision.operationTime,
              family: 'COMMERCIAL_CONTEXT',
              ownerScope: {
                ownerModuleId: 'commerce.customer-context',
                ownerRootRef: 'native-1277:unverified-context',
                predicateRef: 'native-1277:unverified-context',
                tenantId: request.decision.tenantId,
              },
              requestedAt: observedAt,
            },
            retryable: true,
          },
        },
      ],
      requestedAt: observedAt,
      snapshotId: 'native-1277:unused-snapshot',
    },
    startedAt: observedAt,
  });
  const reads = yield* reader.loadCurrent(request, attempt, boundComposition);
  const [first] = reads;
  if (first === undefined || 'failure' in first.authorizationSet) {
    return yield* Effect.die('Native Current set required');
  }
  const evaluated = yield* evaluatePricingLineValues({ authorizationSets: reads, composition: boundComposition });
  return { composition: boundComposition, evaluated, read: first, set: first.authorizationSet };
});

const approvalFor = (composition: Composition, scope: OperationalScope) => {
  const [template] = authorizationSetFor(firstRawLine(composition.lines)).authorizations;
  if (template === undefined) {
    throw new Error('Expected bounded authorization fixture');
  }
  return {
    ...template,
    effectivePeriod: { endsAt: '2027-01-01T00:00:00.000Z', startsAt: composition.decision.operationTime },
    governanceEvidence: { ...template.governanceEvidence, approvedByPrincipalRef: scope.principalId },
  };
};

const approve = Effect.fn('test.approveNativeFloor')(function* approve(
  persistence: ZeroFloorAuthorizationPersistence,
  composition: Composition,
  scope: OperationalScope,
  expectedSetGeneration = 1,
  approvalRevision = 'native-1277:approval:r1',
  validityEndsAt = '2027-01-01T00:00:00.000Z',
) {
  const authorization = approvalFor(composition, scope);
  const command = {
    actingPrincipalId: scope.principalId,
    actionInvocationId: yield* nextId,
    approvalRevision,
    authorization,
    expectedSetGeneration,
    intent: 'APPROVE' as const,
    reason: 'Produce genuine native ZERO_FLOOR approval',
    requestCorrelationId: 'native-1277:approve',
    trustedOperationAt: composition.decision.operationTime,
    validityPeriod: { endsAt: validityEndsAt, startsAt: composition.decision.operationTime },
  };
  const approved = yield* persistence.manage(command);
  expect(approved.outcome).toBe('ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED');
  expect(yield* persistence.manage(command)).toEqual(approved);
  return authorization;
});

const create = Effect.fn('test.createNativeFloor')(function* create(
  persistence: ZeroFloorAuthorizationPersistence,
  composition: Composition,
  scope: OperationalScope,
) {
  const authorization = approvalFor(composition, scope);
  const proof = yield* persistence.readGovernanceProof({
    authorization,
    effectiveAt: composition.decision.operationTime,
  });
  if (proof.outcome !== 'ZERO_FLOOR_AUTHORIZATION_GOVERNANCE_PROOF_CURRENT') {
    return yield* Effect.die('Persisted native approval required');
  }
  const command = {
    actingPrincipalId: scope.principalId,
    actionInvocationId: yield* nextId,
    authorization,
    expectedSetGeneration: 2,
    governanceProof: proof.governanceProof,
    reason: 'Redeem persisted native ZERO_FLOOR approval',
    requestCorrelationId: 'native-1277:create',
    trustedOperationAt: composition.decision.operationTime,
  };
  const created = yield* persistence.create(command);
  expect(created.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_CREATED');
  expect(yield* persistence.create(command)).toEqual(created);
  return created;
});

const failureCode = (failure: Error) =>
  Schema.is(ScopedRoutineInvocationError)(failure)
    ? Option.getOrUndefined(failure.postgresCode)
    : findPostgresFailure(failure).pipe(
        Option.map(({ code }) => code),
        Option.getOrUndefined,
      );
const queryJson = (query: PricingZeroFloorAuthorizationQuery) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ query });
const resolveReceipt = (transaction: ScopedTransactionExecutor, value: Effect.Success<ReturnType<typeof readFloor>>) =>
  transaction.invoke(resolvePricingMaterialProofRoutine, [
    {
      evidenceObservedAt: value.read.authority.observedAt,
      evidenceVerificationRef: value.read.authority.verificationRef,
      expectedFacts: value.read.factProofs,
      family: 'ZERO_FLOOR',
      ownerRootRef: value.read.authority.ownerRootRef,
      ownerSetRevisionRef: value.read.authority.ownerRevision,
      predicateRef: value.read.authority.predicateRef,
      query: value.set.query,
    },
  ]);
const provisionalReads: Effect.Success<ReturnType<typeof readFloor>>[] = [];

it.live('proves native Price→production floor query→empty authority at positive and zero raw boundary (#1277)', () =>
  Effect.scoped(
    Effect.gen(function* nativePositiveAndZero() {
      for (const amount of ['100', '0']) {
        const fixture = yield* makeNativeReadTestContext({
          contextPermissions: [],
          moduleId: 'commerce.pricing',
          ownerFixtureRetention: 'retain-complete-context',
        });
        const fixtureContext = yield* Layer.build(fixture.layer);
        yield* fixture
          .prepareOwner(
            Effect.fn('test.produceAndReadFloor')(function* produceAndReadFloor(transaction, scope) {
              const composition = yield* compositionFor(transaction, scope, amount);
              const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
              yield* approve(persistence, composition, scope);
              const result = yield* readFloor(persistence, composition);
              expect(result.set.authorizations).toEqual([]);
              expect(result.evaluated).toMatchObject({
                lines: [
                  {
                    floorEvaluation: { kind: 'NOT_REQUIRED' },
                    nonNegativePreRoundValue: {
                      amount: expect.stringMatching(new RegExp(`^${amount}(?:\\.0+)?$`, 'u')),
                    },
                  },
                ],
                outcome: 'PRE_ROUND_LINE_VALUES_READY',
              });
              const { query } = result.set;
              const body = yield* queryJson(query);
              const [native] = yield* transaction
                .select({ predicate: sql<string>`pricing.zero_floor_predicate_ref_v1(${body}::jsonb -> 'query')` })
                .from(zeroFloorSetHeads)
                .limit(1);
              expect(result.read.authority.predicateRef).toBe(native?.predicate);
              expect(yield* resolveReceipt(transaction, result)).toHaveLength(1);
              expect(result.read.occurrenceId).toBe(firstRawLine(composition.lines).occurrenceId);
              const { exactPredicateRef: _predicate, ...withoutRef } = query;
              const laterTime = { ...withoutRef, effectiveAt: '2026-09-28T12:00:01.000Z' };
              const later = yield* persistence.readCurrentSet({ query: laterTime });
              expect(later.authorizationSet.exactPredicateRef).toBe(query.exactPredicateRef);
              expect(later.authorizationSet.query.effectiveAt).toBe(laterTime.effectiveAt);
            }),
          )
          .pipe(Effect.provideContext(fixtureContext));
      }
    }),
  ).pipe(withNativeCrypto),
);

it.live(
  'requires exact persisted approval and material coverage for negative raw lines, and rejects stale native generation (#1277)',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeNegativeFloor() {
        const fixture = yield* makeNativeReadTestContext({
          contextPermissions: [],
          moduleId: 'commerce.pricing',
          ownerFixtureRetention: 'retain-complete-context',
        });
        const fixtureContext = yield* Layer.build(fixture.layer);
        yield* fixture
          .prepareOwner(
            Effect.fn('test.negativeNativeFloor')(function* negativeNativeFloor(transaction, scope) {
              const composition = yield* compositionFor(transaction, scope, '100', ['40', '40', '40']);
              const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
              yield* approve(persistence, composition, scope);
              const empty = yield* readFloor(persistence, composition);
              expect(empty.evaluated).toMatchObject({ kind: 'ZERO_FLOOR_FAILED', reasonCode: 'AUTHORIZATION_ABSENT' });
              yield* create(persistence, composition, scope);
              const current = yield* readFloor(persistence, composition);
              expect(current.evaluated).toMatchObject({
                lines: [
                  { floorEvaluation: { kind: 'AUTHORIZED_ZERO_FLOOR' }, nonNegativePreRoundValue: { amount: '0' } },
                ],
                outcome: 'PRE_ROUND_LINE_VALUES_READY',
              });
              expect(current.read.factProofs).toHaveLength(1);
              const { exactPredicateRef: _predicate, ...query } = current.set.query;
              for (const changed of [
                { ...query, materialRevisionRefs: [...query.materialRevisionRefs, 'native-1277:different-material'] },
                { ...query, audienceRefs: [...query.audienceRefs, 'native-1277:different-audience'] },
                { ...query, commercialScope: { ...query.commercialScope, channelId: 'B2B' as const } },
                { ...query, currencyCode: 'EUR' as const },
                { ...query, pricingBasis: { ...query.pricingBasis, quantity: '2' } },
                {
                  ...query,
                  catalogSelection: {
                    ...query.catalogSelection,
                    variantRef: { ...query.catalogSelection.variantRef, resourceId: yield* nextId },
                  },
                },
              ]) {
                const changedSet = yield* persistence.readCurrentSet({ query: changed });
                expect(changedSet.authorizationSet.exactPredicateRef).not.toBe(current.set.exactPredicateRef);
                expect(changedSet.authorizationSet.authorizations).toEqual([]);
              }
              const { authority } = current.read;
              expect(
                yield* persistence.verifyGeneration({
                  ...authority,
                  query: current.set.query,
                  through: authority.observedAt,
                }),
              ).toMatchObject({ outcome: 'ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CURRENT' });
              yield* approve(persistence, composition, scope, authority.generation, 'native-1277:approval:r2');
              expect(
                yield* persistence.verifyGeneration({
                  ...authority,
                  query: current.set.query,
                  through: authority.observedAt,
                }),
              ).toMatchObject({ outcome: 'ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CHANGED' });
            }),
          )
          .pipe(Effect.provideContext(fixtureContext));
      }),
    ).pipe(withNativeCrypto),
);

const NativeFloorConfirmationWitnessSchema = Schema.Struct({
  observedAt: PricingInstantSchema,
  through: PricingInstantSchema,
});
const unrelatedFloorProofPersistence = () =>
  Effect.die('Unrelated owner persistence must not participate in the floor proof');

const nativeRetainedFloorConfirmation = Effect.fn('test.nativeRetainedFloorConfirmation')(
  function* nativeRetainedFloorConfirmation(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    nativeClock: Clock.Clock,
  ) {
    const composition = yield* compositionFor(transaction, scope, '100', ['40', '40', '40']);
    const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
    yield* approve(persistence, composition, scope);
    yield* create(persistence, composition, scope);
    const original = yield* readFloor(persistence, composition);
    expect(original.evaluated).toMatchObject({
      lines: [{ floorEvaluation: { kind: 'AUTHORIZED_ZERO_FLOOR' } }],
      outcome: 'PRE_ROUND_LINE_VALUES_READY',
    });
    const { authority, factProofs } = original.read;
    const { query } = original.set;
    const boundary = original.set.completenessEvidence.nextApplicabilityBoundary;
    if (boundary === undefined) {
      return yield* Effect.die('Native authorization must expose its actual expiry boundary');
    }
    const ownerScope = {
      ownerModuleId: 'commerce.pricing',
      ownerRootRef: authority.ownerRootRef,
      predicateRef: authority.predicateRef,
      tenantId: scope.tenantId,
    };
    const temporal = {
      effectiveAt: query.effectiveAt,
      evaluatedAt: query.effectiveAt,
      evaluationMode: 'HISTORICAL_AS_OF',
      nextMaterialBoundary: boundary,
      observedAt: authority.observedAt,
      requestedAt: query.effectiveAt,
    };
    const source = yield* Schema.decodeUnknownEffect(PricingMaterialEvidenceFenceSourceSchema)({
      sourceEvidence: {
        _tag: 'VERIFIED_PRESENT',
        completeness: {
          completenessEvidence: original.set.completenessEvidence,
          currencyCode: query.currencyCode,
          family: 'ZERO_FLOOR',
          ownerScope,
          ownerSetRevisionRef: authority.ownerRevision,
          temporal,
          verification: {
            kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
            verificationRef: authority.verificationRef,
          },
        },
        currentFacts: original.set.authorizations.map((authorization) => ({
          currencyCode: query.currencyCode,
          effectivePeriod: {
            effectiveFrom: authorization.effectivePeriod.startsAt,
            effectiveTo: authorization.effectivePeriod.endsAt ?? null,
          },
          factRef: authorization.authorizationRef,
          factRevisionRef: authorization.authorizationRevision,
          family: 'ZERO_FLOOR',
          ownerScope,
          temporal,
          verification: {
            kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
            verificationRef: factProofs.find(
              (proof) =>
                proof.factRef === authorization.authorizationRef &&
                proof.factRevisionRef === authorization.authorizationRevision,
            )?.verificationRef,
          },
        })),
        request: {
          currencyCode: query.currencyCode,
          effectiveAt: query.effectiveAt,
          family: 'ZERO_FLOOR',
          ownerScope,
          requestedAt: query.effectiveAt,
        },
      },
      verificationMaterial: {
        kind: 'PRICING_ZERO_FLOOR_AUTHORITY',
        occurrenceId: original.read.occurrenceId,
        ownerReadReceipt: { authority: { ...authority, nextApplicabilityBoundary: boundary }, factProofs },
        query,
      },
    });
    const freshObservations: string[] = [];
    const verifiedWitnesses: (typeof NativeFloorConfirmationWitnessSchema.Type)[] = [];
    const proof = yield* materialEvidenceProofPersistenceForScope(transaction, scope);
    const gateway = makePricingCurrentDecisionPricingOwnerFinalFenceGateway({
      currencySupport: {
        loadCurrent: unrelatedFloorProofPersistence,
        resolveOriginalProof: unrelatedFloorProofPersistence,
        verifyCurrentThrough: unrelatedFloorProofPersistence,
      },
      discounts: {
        readCurrentSet: unrelatedFloorProofPersistence,
        resolveOriginalSetProof: unrelatedFloorProofPersistence,
        verifySetGeneration: unrelatedFloorProofPersistence,
      },
      fees: { readCurrentSet: unrelatedFloorProofPersistence, verifySetGeneration: unrelatedFloorProofPersistence },
      prices: {
        readExactCandidateSet: unrelatedFloorProofPersistence,
        verifyExactCandidateSetGeneration: unrelatedFloorProofPersistence,
      },
      resolveOriginalProof: proof.resolveOriginalProof,
      tiers: {
        readCurrentSet: unrelatedFloorProofPersistence,
        resolveQuantityTierSetProof: unrelatedFloorProofPersistence,
        verifySetGeneration: unrelatedFloorProofPersistence,
      },
      // Observe actual native calls without replacing a read, proof, timestamp, or verifier result.
      zeroFloor: {
        readCurrentSet: (input) =>
          persistence.readCurrentSet(input).pipe(
            Effect.tap((read) =>
              Effect.sync(() => {
                freshObservations.push(read.authority.observedAt);
              }),
            ),
          ),
        verifyGeneration: (input) =>
          persistence.verifyGeneration(input).pipe(
            Effect.tap((checked) =>
              Effect.sync(() => {
                expect(checked).toMatchObject({
                  outcome: 'ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CURRENT',
                  verifiedThrough: input.through,
                });
                verifiedWitnesses.push({ observedAt: input.observedAt, through: input.through });
              }),
            ),
          ),
      },
    });
    const verificationContext = {
      candidateRef: original.composition.candidateRef,
      decision: original.composition.decision,
      effectiveAt: query.effectiveAt,
      evaluatedAt: authority.observedAt,
      requestedAt: query.effectiveAt,
    };
    const phaseOne = yield* gateway.verifyOpaqueProofsAgainstCurrentState({
      candidateRef: original.composition.candidateRef,
      compositionRevision: 'native-1277:retained-witness',
      sources: [
        {
          currencyCode: query.currencyCode,
          currentFacts: factProofs,
          evidenceObservedAt: authority.observedAt,
          evidenceVerificationRef: authority.verificationRef,
          family: 'ZERO_FLOOR',
          nextMaterialBoundary: boundary,
          ownerModuleId: 'commerce.pricing',
          ownerRootRef: authority.ownerRootRef,
          ownerSetRevisionRef: authority.ownerRevision,
          predicateRef: authority.predicateRef,
          tenantId: scope.tenantId,
        },
      ],
      typedSources: [source],
      verificationContext,
    });
    const [clock] = yield* transaction
      .select({
        completedAt: sql<string>`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      })
      .from(zeroFloorSetHeads)
      .limit(1);
    const through = yield* Schema.decodeUnknownEffect(PricingInstantSchema)(clock?.completedAt);
    expect(authority.observedAt <= through).toBe(true);
    expect(freshObservations).toHaveLength(1);
    expect(freshObservations[0] !== undefined && freshObservations[0] <= through).toBe(true);
    yield* nativeClock.sleep(Duration.millis(5));
    const confirmationInput = {
      candidateRef: original.composition.candidateRef,
      compositionRevision: 'native-1277:retained-witness',
      observations: phaseOne.observations,
      through,
      typedSources: [source],
      verificationContext,
    };
    expect((yield* gateway.confirmObservedGenerationsThrough(confirmationInput)).verifiedThrough).toBe(through);
    expect(freshObservations).toHaveLength(2);
    expect(freshObservations[1] !== undefined && freshObservations[1] > through).toBe(true);
    expect(verifiedWitnesses).toEqual([{ observedAt: authority.observedAt, through }]);
    expect(yield* resolveReceipt(transaction, original)).toHaveLength(1);
    yield* approve(persistence, composition, scope, authority.generation, 'native-1277:confirmation-generation-change');
    const changed = yield* gateway.confirmObservedGenerationsThrough(confirmationInput).pipe(Effect.flip);
    expect(changed).toBeInstanceOf(PricingOwnerMaterialEvidenceFenceGatewayUnavailable);
    expect(changed.reason).toBe('Zero Floor generation changed before aggregate completion');
    expect(verifiedWitnesses).toHaveLength(1);
    return yield* Effect.void;
  },
);

it.live(
  'confirms the retained native ZERO_FLOOR witness after a later production reread and refuses changed generation (#1277)',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeRetainedFloorWitness() {
        const nativeClock = yield* Clock.Clock;
        const fixture = yield* makeNativeReadTestContext({
          contextPermissions: [],
          moduleId: 'commerce.pricing',
          ownerFixtureRetention: 'retain-complete-context',
        });
        const fixtureContext = yield* Layer.build(fixture.layer);
        yield* fixture
          .prepareOwner(
            Effect.fn('test.nativeRetainedFloorConfirmation')((transaction, scope) =>
              nativeRetainedFloorConfirmation(transaction, scope, nativeClock),
            ),
          )
          .pipe(Effect.provideContext(fixtureContext));
      }),
    ).pipe(withNativeCrypto),
);

it.live(
  'keeps native input/scope guards and initializes a stable empty authority without authorizing negative lines (#1277)',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeFloorGuards() {
        const fixture = yield* makeNativeReadTestContext({
          contextPermissions: [],
          moduleId: 'commerce.pricing',
          ownerFixtureRetention: 'retain-complete-context',
        });
        const fixtureContext = yield* Layer.build(fixture.layer);
        const state = yield* fixture
          .prepareOwner(
            Effect.fn('test.prepareFloorGuards')(function* prepareFloorGuards(transaction, scope) {
              const composition = yield* compositionFor(transaction, scope);
              const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
              yield* approve(persistence, composition, scope);
              const current = yield* readFloor(persistence, composition);
              return { current };
            }),
          )
          .pipe(Effect.provideContext(fixtureContext));
        const { query } = state.current.set;
        for (const changed of [
          { ...query, exactPredicateRef: 'pricing-zero-floor:wrong-occurrence-label' },
          { ...query, materialRevisionRefs: [...query.materialRevisionRefs, 'different'] },
          { ...query, effectiveAt: '2099-01-01T00:00:00.000Z' },
          { ...query, effectiveAt: null },
          { ...query, commercialScope: { ...query.commercialScope, sellingLegalEntityId: yield* nextId } },
          { ...query, tenantId: yield* nextId },
        ]) {
          const failed = yield* Effect.flip(
            fixture
              .prepareOwner(
                Effect.fn('test.rejectStrictFloorInput')(function* rejectStrictFloorInput(transaction) {
                  return yield* transaction.invoke(readCurrentZeroFloorAuthorizationSetRoutine, [{ query: changed }]);
                }),
              )
              .pipe(Effect.provideContext(fixtureContext)),
          );
          expect(failureCode(failed)).toBe('22023');
        }
        const bootstrapFailed = yield* Effect.flip(
          fixture
            .prepareOwner(
              Effect.fn('test.rejectSuppliedBootstrapPredicate')(
                function* rejectSuppliedBootstrapPredicate(transaction) {
                  return yield* transaction.invoke(readCurrentZeroFloorAuthorizationSetForQueryRoutine, [{ query }]);
                },
              ),
            )
            .pipe(Effect.provideContext(fixtureContext)),
        );
        expect(failureCode(bootstrapFailed)).toBe('22023');
        const body = yield* queryJson(query);
        const foreignTenant = yield* nextId;
        const scopeFailed = yield* Effect.flip(
          fixture
            .prepareOwner(
              Effect.fn('test.rejectForeignFloorScope')(function* rejectForeignFloorScope(transaction, scope) {
                return yield* transaction
                  .select({
                    payload: sql<unknown>`pricing.read_current_zero_floor_authorization_set_v1(${foreignTenant}::uuid, ${scope.legalEntityId}::uuid, ${body}::jsonb)`,
                  })
                  .from(zeroFloorSetHeads)
                  .limit(1);
              }),
            )
            .pipe(Effect.provideContext(fixtureContext)),
        );
        expect(failureCode(scopeFailed)).toBe('42501');
        expect(
          yield* fixture
            .prepareOwner((transaction) => resolveReceipt(transaction, state.current))
            .pipe(Effect.provideContext(fixtureContext)),
        ).toHaveLength(1);
        const missing = yield* makeNativeReadTestContext({
          contextPermissions: [],
          moduleId: 'commerce.pricing',
          ownerFixtureRetention: 'retain-complete-context',
        });
        const missingContext = yield* Layer.build(missing.layer);
        const initialized = yield* missing
          .prepareOwner(
            Effect.fn('test.initializeEmptyFloorAuthority')(
              function* initializeEmptyFloorAuthority(transaction, scope) {
                const composition = yield* compositionFor(transaction, scope, '100', ['40', '40', '40']);
                expect(
                  yield* transaction.select({ generation: zeroFloorSetHeads.generation }).from(zeroFloorSetHeads),
                ).toEqual([]);
                const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
                const current = yield* readFloor(persistence, composition);
                expect(current.read.authority.generation).toBe(1);
                expect(current.set.authorizations).toEqual([]);
                expect(current.read.factProofs).toEqual([]);
                expect(current.evaluated).toMatchObject({
                  kind: 'ZERO_FLOOR_FAILED',
                  reasonCode: 'AUTHORIZATION_ABSENT',
                });
                expect(yield* resolveReceipt(transaction, current)).toHaveLength(1);
                return current;
              },
            ),
          )
          .pipe(Effect.provideContext(missingContext));
        yield* missing
          .prepareOwner(
            Effect.fn('test.replayEmptyFloorAuthority')(function* replayEmptyFloorAuthority(transaction, scope) {
              const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
              const replay = yield* readFloor(persistence, initialized.composition);
              const { observedAt: originalObservedAt, ...originalAuthority } = initialized.read.authority;
              const { observedAt: replayObservedAt, ...replayAuthority } = replay.read.authority;
              expect(replayObservedAt >= originalObservedAt).toBe(true);
              expect(replayAuthority).toEqual(originalAuthority);
              expect(replay.set.query).toEqual(initialized.set.query);
              expect(replay.set.authorizations).toEqual([]);
              expect(replay.read.factProofs).toEqual([]);
              expect(replay.evaluated).toMatchObject({ kind: 'ZERO_FLOOR_FAILED', reasonCode: 'AUTHORIZATION_ABSENT' });
              expect(
                yield* transaction.select({ generation: zeroFloorSetHeads.generation }).from(zeroFloorSetHeads),
              ).toEqual([{ generation: 1 }]);
              expect(yield* resolveReceipt(transaction, initialized)).toHaveLength(1);
              expect(yield* resolveReceipt(transaction, replay)).toHaveLength(1);
            }),
          )
          .pipe(Effect.provideContext(missingContext));
      }),
    ).pipe(withNativeCrypto),
);

const floorReadEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'pricing.zero_floor.native_test.read' },
  entrypointKey: 'commerce.pricing.test.zero-floor-native-predicate',
  moduleKey: 'commerce.pricing',
  role: 'api',
});
const floorRead = defineRead(
  {
    accessKind: 'detail',
    entrypoint: floorReadEntrypoint,
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'commerce.pricing.test.zero-floor-native-predicate.evidence.v1',
    },
    inputSchema: Schema.Struct({ composition: PricingRawCompositionReadySchema, invalidPredicate: Schema.Boolean }),
    legalEntityScope: 'required',
    owningModuleKey: 'commerce.pricing',
    permissionTarget: 'module',
    policies: [],
    readKey: 'commerce.pricing.test.zero-floor-native-predicate',
    resultSchema: Schema.Struct({ outcome: Schema.String }),
    schemaVersion: '1',
  },
  (input, context: ReadHandlerContext<ZeroFloorAuthorizationPersistence>) =>
    Effect.gen(function* localGovernedFloorHandler() {
      const result = yield* readFloor(context.services, input.composition);
      if (input.invalidPredicate) {
        provisionalReads.push(result);
        // Mirrors a whole-evaluation closeFailure: catching an owner error cannot repair
        // an aborted PostgreSQL transaction or prove a committed typed Pricing result.
        yield* context.services
          .readCurrentSet({ query: { ...result.set.query, exactPredicateRef: 'pricing-zero-floor:bad' } })
          .pipe(Effect.catchTag('ZeroFloorAuthorizationPersistenceUnavailable', () => Effect.void));
      }
      return {
        evidence: { resultCount: 1 },
        result: { outcome: 'outcome' in result.evaluated ? result.evaluated.outcome : result.evaluated.kind },
      };
    }).pipe(
      Effect.mapError(
        () =>
          new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: 'Native ZERO_FLOOR owner unavailable',
          }),
      ),
    ),
  zeroFloorAuthorizationPersistenceForScope,
  () => ({ kind: 'module', moduleId: 'commerce.pricing' }),
);

it.live(
  'settles real Core evidence for the local floor reader/evaluator and rolls back SQL-aborted pseudo-success (#1277)',
  () =>
    Effect.scoped(
      Effect.gen(function* governedNativeFloor() {
        const fixture = yield* makeNativeReadTestContext({
          contextPermissions: ['pricing.zero_floor.native_test.read'],
          moduleId: 'commerce.pricing',
          ownerFixtureRetention: 'retain-complete-context',
        });
        const fixtureContext = yield* Layer.build(fixture.layer);
        const preparedComposition = yield* fixture
          .prepareOwner(
            Effect.fn('test.prepareGovernedFloor')(function* prepareGovernedFloor(transaction, scope) {
              const composition = yield* compositionFor(transaction, scope);
              const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
              yield* approve(persistence, composition, scope);
              return composition;
            }),
          )
          .pipe(Effect.provideContext(fixtureContext));
        const before = yield* fixture.evidenceCount();
        expect(
          yield* fixture.runtime
            .runRead({
              input: { composition: preparedComposition, invalidPredicate: false },
              principal: fixture.principal,
              registration: floorRead,
              transport: { correlationId: 'native-1277:governed-success' },
            })
            .pipe(Effect.provideContext(fixtureContext)),
        ).toEqual({ outcome: 'PRE_ROUND_LINE_VALUES_READY' });
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
        const failed = yield* Effect.flip(
          fixture.runtime
            .runRead({
              input: { composition: preparedComposition, invalidPredicate: true },
              principal: fixture.principal,
              registration: floorRead,
              transport: { correlationId: 'native-1277:governed-abort' },
            })
            .pipe(Effect.provideContext(Context.merge(fixtureContext, loggerContext))),
        );
        // Core settles the owner transaction before writing read evidence. The caught SQL error
        // therefore fails the checked COMMIT, not an evidence INSERT with PostgreSQL code 25P02.
        expect(Schema.is(ReadHandlerExecutionError)(failed)).toBe(true);
        expect(failed).toMatchObject({
          code: 'read_handler_execution_failed',
          reason: 'The governed read transaction failed',
        });
        const settlement = yield* Schema.decodeUnknownEffect(Schema.Struct({ cause: Schema.toType(SqlError) }))(failed);
        expect(Schema.is(UnknownError)(settlement.cause.reason)).toBe(true);
        expect(settlement.cause.reason.message).toBe('PgClient: COMMIT rolled back an aborted transaction');
        expect(settlement.cause.reason.operation).toBe('commit');
        expect(settlement.cause.reason.cause).toBeInstanceOf(Error);
        expect(settlement.cause.reason.cause).toHaveProperty('message', 'COMMIT rolled back an aborted transaction');
        expect(logLevels).toEqual(['Error']);
        expect(yield* fixture.evidenceCount()).toBe(before + 1);
        const [rolledBack] = provisionalReads;
        if (rolledBack === undefined) {
          return yield* Effect.die('Expected actual provisional owner proof before SQL abort');
        }
        expect(
          yield* fixture
            .prepareOwner((transaction) => resolveReceipt(transaction, rolledBack))
            .pipe(Effect.provideContext(fixtureContext)),
        ).toHaveLength(0);
        expect(
          yield* fixture.runtime
            .runRead({
              input: { composition: preparedComposition, invalidPredicate: false },
              principal: fixture.principal,
              registration: floorRead,
              transport: { correlationId: 'native-1277:governed-after-rollback' },
            })
            .pipe(Effect.provideContext(fixtureContext)),
        ).toEqual({ outcome: 'PRE_ROUND_LINE_VALUES_READY' });
        expect(yield* fixture.evidenceCount()).toBe(before + 2);
        const denied = yield* makeNativeReadTestContext({
          contextPermissions: [],
          moduleId: 'commerce.pricing',
          ownerFixtureRetention: 'retain-complete-context',
        });
        const deniedContext = yield* Layer.build(denied.layer);
        const deniedResult = yield* Effect.flip(
          denied.runtime
            .runRead({
              input: { composition: preparedComposition, invalidPredicate: false },
              principal: denied.principal,
              registration: floorRead,
              transport: { correlationId: 'native-1277:permission-denied' },
            })
            .pipe(Effect.provideContext(deniedContext)),
        );
        expect(deniedResult).toMatchObject({ code: 'read_permission_denied' });
        return yield* Effect.void;
      }),
    ).pipe(withNativeCrypto),
);

it.live('keeps the economic envelope and expired persisted approval fail-closed on native owner inputs (#1277)', () =>
  Effect.scoped(
    Effect.gen(function* nativeFloorEconomicAndExpiry() {
      const fixture = yield* makeNativeReadTestContext({
        contextPermissions: [],
        moduleId: 'commerce.pricing',
        ownerFixtureRetention: 'retain-complete-context',
      });
      const fixtureContext = yield* Layer.build(fixture.layer);
      yield* fixture
        .prepareOwner(
          Effect.fn('test.nativeFloorEconomicLimit')(function* nativeFloorEconomicLimit(transaction, scope) {
            const composition = yield* compositionFor(transaction, scope, '100', ['40', '40', '41']);
            const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
            yield* approve(persistence, composition, scope);
            yield* create(persistence, composition, scope);
            const result = yield* readFloor(persistence, composition);
            expect(result.evaluated).toMatchObject({
              kind: 'ZERO_FLOOR_FAILED',
              reasonCode: 'ECONOMIC_COVERAGE_EXCEEDED',
            });
          }),
        )
        .pipe(Effect.provideContext(fixtureContext));
      const expired = yield* makeNativeReadTestContext({
        contextPermissions: [],
        moduleId: 'commerce.pricing',
        ownerFixtureRetention: 'retain-complete-context',
      });
      const expiredContext = yield* Layer.build(expired.layer);
      const expiredInput = yield* expired
        .prepareOwner(
          Effect.fn('test.produceExpiredApproval')(function* produceExpiredApproval(transaction, scope) {
            const composition = yield* compositionFor(transaction, scope, '100', ['40', '40', '40']);
            const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
            const authorization = yield* approve(
              persistence,
              composition,
              scope,
              1,
              'native-1277:expired',
              '2026-09-30T00:00:00.000Z',
            );
            return { authorization, effectiveAt: composition.decision.operationTime };
          }),
        )
        .pipe(Effect.provideContext(expiredContext));
      const failed = yield* Effect.flip(
        expired
          .prepareOwner((transaction) =>
            transaction.invoke(readCurrentZeroFloorAuthorizationGovernanceProofRoutine, [expiredInput]),
          )
          .pipe(Effect.provideContext(expiredContext)),
      );
      expect(failureCode(failed)).toBe('P0002');
    }),
  ).pipe(withNativeCrypto),
);
