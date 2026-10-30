import { defineRead, defineTenantModuleEntrypoint, ReadHandlerUnavailable } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor, ReadHandlerContext } from '@app/core-runtime';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts/current-supported-currencies';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import {
  PricingRawCompositionReadySchema,
  PricingLineCompositionRequestSchema,
} from '@app/pricing-contracts/domain/line-composition';
import { PricingEvaluationAttemptSchema } from '@app/pricing-contracts/domain/material-change';
import { PriceRevisionSchema } from '@app/pricing-contracts/domain/price-definition';
import { QuantityTierSelectionSuccessSchema } from '@app/pricing-contracts/domain/quantity-tier';
import { ScheduledPriceRevisionSchema } from '@app/pricing-contracts/domain/price-schedule';
import { ExactPriceLookupFoundSchema } from '@app/pricing-contracts/domain/exact-price-lookup';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import type {
  PromotionContributionRequest,
  PromotionContributionApplied,
} from '@app/pricing-contracts/domain/promotion-contribution';
import { NodeCrypto, NodeServices, NodeChildProcessSpawner } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { makeCurrentPricingDecisionZeroFloorSetReader } from '../../src/integrations/current-pricing-decision-whole-evaluation-adapters.ts';
import type { ZeroFloorAuthorizationPersistence } from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { zeroFloorAuthorizationPersistenceForScope } from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { pricePersistenceForScope } from '../../src/services/price-persistence.service.ts';
import { currencySupportPersistenceForScope } from '../../src/persistence/currency-support-persistence.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';
import { resolveCurrentSupportedCurrencies } from '../../src/api/current-supported-currencies.read.ts';
import { composePricingRawLines } from '../../src/services/line-value-composition.service.ts';
import { evaluatePricingLineValues } from '../../src/services/line-value-calculation.service.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import { composePricingDiscounts } from '../../src/services/discount-composition.service.ts';
import { composePricingDiscountFeeAllocations } from '../../src/services/discount-fee-allocation-composition.service.ts';
import { makePricingPromotionCompositionService } from '../../src/services/promotion-contribution-composition.service.ts';
import { makePricingPromotionCurrentEvaluationService } from '../../src/services/promotion-current-evaluation.service.ts';
import { publishPricingPromotionCurrentEvaluation } from '../../src/services/promotion-composition-result.service.ts';
import { contractualDiscountPersistenceForScope } from '../../src/services/contractual-discount-persistence.service.ts';
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
  const established = yield* currencies.setCurrent({
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
  expect(established.outcome).toBe('CREATED');
  const support = yield* resolveCurrentSupportedCurrencies(
    { effectiveAt: operationTime, tenantId: scope.tenantId },
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
    mapping: { mappingContractRef: 'native-1249:mapping', mappingContractVersion: '1' },
    originalAssertion: { monetaryAmount: money, monetaryBoundary: 'PRE_TAX', unitBasis: key.unitBasis },
    sourceAssertionId: yield* nextId,
    sourceAuthority: { sourceAuthorityRef: 'native-1249:owner-source', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: actionInvocationId,
      sourceRecordRef: priceId,
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'native-1249:source' },
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

type Composition = typeof PricingRawCompositionReadySchema.Type;

const readFloor = Effect.fn('test.actualNativeFloorReader')(function* readFloor(
  persistence: ZeroFloorAuthorizationPersistence,
  composition: Composition,
) {
  const subject = {
    guestEvidenceRef: 'native-1249:guest',
    guestSessionRef: 'native-1249:session',
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
    attemptId: 'native-1249:unused-attempt',
    attemptOrdinal: 1,
    candidateRef: composition.candidateRef,
    completedAt: observedAt,
    maxAttempts: 2,
    runId: 'native-1249:unused-run',
    snapshot: {
      attemptId: 'native-1249:unused-attempt',
      calculationVersions: {
        allocationContractVersions: [],
        arithmeticProfileVersions: ['native-1249:precondition'],
        publicationProfileVersions: ['native-1249:precondition'],
      },
      candidateRef: composition.candidateRef,
      capturedAt: observedAt,
      decision: request.decision,
      materialBindings: [
        {
          bindingRef: 'native-1249:unverified-context',
          kind: 'SUBJECT_OR_GUEST',
          meaningRef: 'native-1249:upstream-precondition',
          sourceEvidence: {
            _tag: 'UNVERIFIABLE',
            observedAt,
            reason: 'OWNER_UNAVAILABLE',
            request: {
              effectiveAt: request.decision.operationTime,
              family: 'COMMERCIAL_CONTEXT',
              ownerScope: {
                ownerModuleId: 'commerce.customer-context',
                ownerRootRef: 'native-1249:unverified-context',
                predicateRef: 'native-1249:unverified-context',
                tenantId: request.decision.tenantId,
              },
              requestedAt: observedAt,
            },
            retryable: true,
          },
        },
      ],
      requestedAt: observedAt,
      snapshotId: 'native-1249:unused-snapshot',
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
  const [template] = authorizationSetFor(
    composition.lines.find(({ occurrenceId }) => occurrenceId === 'line-b') ?? firstRawLine(composition.lines),
  ).authorizations;
  if (template === undefined) {
    throw new Error('Expected bounded authorization fixture');
  }
  return {
    ...template,
    economicCoverage: { maximumFloorAdjustment: '100', minimumRawAmount: '-100' },
    effectivePeriod: { endsAt: '2027-01-01T00:00:00.000Z', startsAt: composition.decision.operationTime },
    governanceEvidence: { ...template.governanceEvidence, approvedByPrincipalRef: scope.principalId },
  };
};

const approve = Effect.fn('test.approveNativeFloor')(function* approve(
  persistence: ZeroFloorAuthorizationPersistence,
  composition: Composition,
  scope: OperationalScope,
  expectedSetGeneration = 1,
  approvalRevision = 'native-1249:approval:r1',
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
    requestCorrelationId: 'native-1249:approve',
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
    requestCorrelationId: 'native-1249:create',
    trustedOperationAt: composition.decision.operationTime,
  };
  const created = yield* persistence.create(command);
  expect(created.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_CREATED');
  expect(yield* persistence.create(command)).toEqual(created);
  return created;
});

const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const precision = {
  allocationScale: 18 as const,
  amountPrecision: 76 as const,
  contractVersion: 'pricing-allocation-v1' as const,
  remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC' as const,
};

const produceMixedCandidate = Effect.fn('test.produceMixedPromotionCandidate')(function* produceMixedCandidate(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) {
  // Catalog, subject and Price Group are explicit schema-valid upstream preconditions.
  // Native Currency support, exact Price and the nonzero Discount are real owner facts.
  const a = yield* makeIssue779Scenario({
    discounts: ['0', '0', '0'],
    feeAmount: '0',
    occurrenceId: 'line-a',
    priceAmount: '100',
  });
  const b = yield* makeIssue779Scenario({
    discounts: ['0', '200', '0'],
    feeAmount: '0',
    occurrenceId: 'line-b',
    priceAmount: '100',
  });
  const decision = {
    ...a.compositionRequest.decision,
    lines: [...a.compositionRequest.decision.lines, ...b.compositionRequest.decision.lines],
    purchasingContext: {
      ...a.compositionRequest.decision.purchasingContext,
      actor: { guestEvidenceRef: 'native-1249:guest', guestSessionRef: 'native-1249:session', kind: 'GUEST' as const },
      subject: {
        guestEvidenceRef: 'native-1249:guest',
        guestSessionRef: 'native-1249:session',
        kind: 'GUEST' as const,
      },
    },
  };
  const discounts = yield* composePricingDiscounts({
    ...a.compositionRequest.discountComposition.request,
    candidates: b.compositionRequest.discountComposition.request.candidates,
    decision,
    lineBases: [
      ...a.compositionRequest.discountComposition.request.lineBases,
      ...b.compositionRequest.discountComposition.request.lineBases,
    ],
  });
  if (discounts.outcome !== 'DISCOUNT_COMPOSITION_READY') {
    return yield* Effect.die('Expected unambiguous precursor Discount');
  }
  const request = {
    candidateRef: 'native-1249:candidate',
    decision,
    discountComposition: discounts,
    feeResults: [...a.compositionRequest.feeResults, ...b.compositionRequest.feeResults].flatMap((fee) =>
      fee.outcome === 'COMMERCIAL_FEES_APPLIED' ? [{ ...fee, input: { ...fee.input, decision } }] : [],
    ),
    promotionComposition: { kind: 'PROMOTION_NOT_SELECTED' as const },
    unitPrices: [a.unitPrice, b.unitPrice],
  };
  const rebind = (value: FixtureValue): Effect.Effect<FixtureValue, Schema.SchemaError> =>
    Effect.gen(function* bindScope() {
      if (Schema.is(Schema.String)(value)) {
        return value
          .replaceAll(decision.tenantId, scope.tenantId)
          .replaceAll(decision.commercialScope.sellingLegalEntityId, scope.legalEntityId ?? 'missing-legal-entity');
      }
      return yield* mapFixtureChildren(value, rebind);
    });
  const scoped = yield* Schema.decodeUnknownEffect(Schema.toType(PricingLineCompositionRequestSchema))(
    yield* rebind(request),
  );
  const raw = yield* composePricingRawLines(scoped);
  if (raw.outcome !== 'RAW_COMPOSITION_READY') {
    return yield* Effect.die('Expected complete pre-Promotion raw precursor');
  }
  const native = yield* produceNativePrice(transaction, scope, raw);
  const template = scoped.discountComposition.request.candidates.find(
    (candidate) => candidate.kind === 'VARIANT_LINE' && candidate.layer === 'PRICE_GROUP_CONTRACTUAL',
  );
  if (template === undefined || template.kind !== 'VARIANT_LINE') {
    return yield* Effect.die('Expected exact contractual line Discount precondition');
  }
  const persistence = yield* contractualDiscountPersistenceForScope(transaction, scope);
  const actionInvocationId = yield* nextId;
  const created = yield* persistence.manage({
    actingPrincipalId: scope.principalId,
    actionInvocationId,
    configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT', level: money('200') },
    effectivePeriod: { effectiveFrom: native.decision.operationTime, effectiveTo: null },
    expectedState: { state: 'ABSENT' },
    identityKey: template.definition.identityKey,
    intent: 'CREATE',
    reason: 'Native unrelated line Discount for eligible subset regression',
    requestCorrelationId: actionInvocationId,
    trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(native.decision.operationTime)),
  });
  expect(created.outcome).toBe('CONTRACTUAL_DISCOUNT_CREATED');
  const current = yield* persistence.readCurrentSet({
    audiences: [template.definition.identityKey.audience],
    basis: template.definition.identityKey.basis,
    commercialScope: native.decision.commercialScope,
    currencyCode: 'CZK',
    effectiveAt: native.decision.operationTime,
    tenantId: scope.tenantId,
  });
  const [retained] = current.currentDiscounts;
  if (retained === undefined) {
    return yield* Effect.die('Native retained Discount must be Current');
  }
  expect(retained.definition.revision.configuredEffect).toEqual({ kind: 'FIXED_MONETARY_AMOUNT', level: money('200') });
  const nativeDiscounts = yield* composePricingDiscounts({
    ...scoped.discountComposition.request,
    candidates: [{ ...template, definition: retained.definition }],
    currencySupport: firstRawLine(native.lines).unitPriceCalculation.input.exactPrice.currencySupport,
  });
  if (nativeDiscounts.outcome !== 'DISCOUNT_COMPOSITION_READY') {
    return yield* Effect.die('Expected actual native Discount contribution');
  }
  expect(nativeDiscounts.lineContributions.map(({ amount }) => amount.amount)).toEqual(['-200']);
  const feeResults = native.lines.map(({ feeCalculation }) => feeCalculation);
  const allocation = yield* composePricingDiscountFeeAllocations({
    discountComposition: nativeDiscounts,
    feeResults,
    precision,
    recipientClassifications: native.lines.map(({ occurrenceId }) => ({ occurrenceId, recipientKind: 'MERCHANDISE' })),
  });
  if (allocation.outcome !== 'ALLOCATION_COMPOSITION_READY') {
    return yield* Effect.die('Expected real native pre-Promotion producer');
  }
  expect(allocation.composedLines.map(({ rawPostAllocationValue }) => rawPostAllocationValue.amount)).toEqual([
    '100',
    '-100',
  ]);
  const nativeCurrency = firstRawLine(native.lines).unitPriceCalculation.input.exactPrice.currencySupport;
  const subjectEvidence = {
    evidenceRef: 'native-1249:subject',
    observedAt: native.decision.operationTime,
    ownerModuleId: 'commerce.customer-context',
    ownerRevision: 'native-1249:subject-precondition',
    provenanceRef: 'native-1249:subject-precondition',
    revalidatedAt: native.decision.operationTime,
    subject: { guestEvidenceRef: 'native-1249:guest', kind: 'GUEST' as const, tenantId: scope.tenantId },
  };
  const ownerOutcome = (ownerRequest: PromotionContributionRequest): PromotionContributionApplied => ({
    _tag: 'PROMOTION_CONTRIBUTION_APPLIED',
    allocations: [
      {
        amount: money('-10'),
        catalogSelection: firstRawLine(native.lines).line.catalog.selection,
        occurrenceId: 'line-a',
        recipientKind: 'MERCHANDISE',
      },
    ],
    applicationIdentity: {
      applicationKind: 'PROMOTION_APPLICATION',
      applicationRef: 'native-1249:application',
      applicationRevision: 'native-1249:application-r1',
      originalApplicationRef: ownerRequest.applicationRequestRef,
    },
    contribution: money('-10'),
    ownerEvidence: {
      completenessEvidence: {
        observedAt: native.decision.operationTime,
        ownerRevision: 'native-1249:injected-promotion-r1',
        scope: { kind: 'EXACT_PREDICATE', predicateRef: ownerRequest.exactPredicateRef },
      },
      currentness: {
        evaluatedAt: native.decision.operationTime,
        observedAt: native.decision.operationTime,
        revalidatedAt: native.decision.operationTime,
        status: 'CURRENT',
      },
      exactPredicateRef: ownerRequest.exactPredicateRef,
      ownerModuleId: 'commerce.promotion',
      ownerRevision: 'native-1249:injected-promotion-r1',
      provenanceRef: 'native-1249:injected-owner-proof',
    },
    request: ownerRequest,
    target: { kind: 'MERCHANDISE_ONLY', occurrenceIds: ['line-a'] },
  });
  const composition = makePricingPromotionCompositionService({
    evaluate: (ownerRequest) => Effect.succeed(ownerOutcome(ownerRequest)),
  });
  const evaluation = yield* makePricingPromotionCurrentEvaluationService(composition.compose, {
    revalidate: ({ expectedOwnerEvidence }) =>
      Effect.succeed({ _tag: 'PROMOTION_OWNER_EVIDENCE_CURRENT', ownerEvidence: expectedOwnerEvidence }),
  }).evaluate({
    loadFresh: () =>
      Effect.succeed({
        applicationRequestRef: 'native-1249:request',
        candidateRef: native.candidateRef,
        currencyCompatibility: {
          currencyCode: 'CZK',
          evidenceRef: nativeCurrency.verificationRef,
          observedAt: nativeCurrency.observedAt,
          ownerRevision: nativeCurrency.supportRevisionRef.resourceId,
          status: 'SUPPORTED_CURRENT',
          tenantId: scope.tenantId,
        },
        decision: native.decision,
        exactPredicateRef: 'native-1249:exact-promotion',
        pricingComposition: allocation,
        pricingCompositionRef: 'native-1249:pricing-composition',
        pricingCompositionRevision: 'native-1249:pricing-composition-r1',
        subjectEvidence,
      }),
  });
  const published = yield* publishPricingPromotionCurrentEvaluation(evaluation);
  expect(published.lines.map(({ rawPreTaxValue }) => rawPreTaxValue.amount)).toEqual(['90', '-100']);
  const finalRaw = yield* composePricingRawLines({
    candidateRef: native.candidateRef,
    decision: native.decision,
    discountComposition: nativeDiscounts,
    feeResults,
    promotionComposition: { composition: published, kind: 'PROMOTION_SELECTED' },
    unitPrices: native.lines.map(({ unitPriceCalculation }) => unitPriceCalculation),
  });
  if (finalRaw.outcome !== 'RAW_COMPOSITION_READY') {
    return yield* Effect.die('Expected complete real raw Promotion composition');
  }
  expect(finalRaw.lines.map(({ negativeOrigin }) => negativeOrigin)).toEqual(['NONE', 'LINE_NATIVE_COMPOSITION']);
  return finalRaw;
});

const readEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'pricing.promotion.subset.native_test.read' },
  entrypointKey: 'commerce.pricing.test.promotion-eligible-subset',
  moduleKey: 'commerce.pricing',
  role: 'api',
});
const governedRead = defineRead(
  {
    accessKind: 'detail',
    entrypoint: readEntrypoint,
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'commerce.pricing.test.promotion-eligible-subset.evidence.v1',
    },
    inputSchema: PricingRawCompositionReadySchema,
    legalEntityScope: 'required',
    owningModuleKey: 'commerce.pricing',
    permissionTarget: 'module',
    policies: [],
    readKey: 'commerce.pricing.test.promotion-eligible-subset',
    resultSchema: Schema.Struct({ total: Schema.String, values: Schema.Array(Schema.String) }),
    schemaVersion: '1',
  },
  (input, context: ReadHandlerContext<ZeroFloorAuthorizationPersistence>) =>
    Effect.gen(function* publishNativeSubset() {
      const result = yield* readFloor(context.services, input);
      if (!('outcome' in result.evaluated) || result.evaluated.outcome !== 'PRE_ROUND_LINE_VALUES_READY') {
        return yield* Effect.die('Native governed floor must produce ready values');
      }
      expect(result.evaluated.lines.map(({ nonNegativePreRoundValue }) => nonNegativePreRoundValue.amount)).toEqual([
        '90',
        '0',
      ]);
      const publication = yield* publishPricingLineValues({
        candidateRef: input.candidateRef,
        decision: result.composition.decision,
        preRound: result.evaluated,
        publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
      });
      if (publication.outcome !== 'LINE_VALUES_PUBLISHED') {
        return yield* Effect.die('Native floor values must publish');
      }
      const total = yield* calculatePricingCommercialTotals({
        candidateRef: input.candidateRef,
        decision: result.composition.decision,
        preRound: result.evaluated,
        publishedLines: publication.publishedLines,
      });
      if (total.outcome !== 'COMMERCIAL_TOTAL_READY') {
        return yield* Effect.die('Exact published lines must yield commercial total');
      }
      expect(total.pricingNetCommercialTotal).toEqual(money('90'));
      expect(total.breakdown.promotionAllocationTotal).toEqual(money('-10'));
      expect(total.breakdown.zeroFloorAdjustmentTotal).toEqual(money('100'));
      return {
        evidence: { resultCount: 2 },
        result: {
          total: total.pricingNetCommercialTotal.amount,
          values: publication.publishedLines.map(({ publishedLineValue }) => publishedLineValue.amount),
        },
      };
    }).pipe(
      Effect.mapError(
        () =>
          new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: 'Native eligible subset proof unavailable',
          }),
      ),
    ),
  zeroFloorAuthorizationPersistenceForScope,
  () => ({ kind: 'module', moduleId: 'commerce.pricing' }),
);

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.live(
  'retains the complete native Discount candidate, applies the exact injected Promotion subset once, and publishes floor-governed total 90',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeTestBoundary() {
        const services = yield* Layer.build(nativeServices);
        return yield* Effect.gen(function* nativePromotionSubset() {
          const composition = yield* makeApplicationCompositionSnapshotFixture(
            ['pricing'],
            ultramodernApiMarker.buildMarker,
          );
          const isolated = yield* makeIsolatedNativeDatabaseFixture({
            compositionSnapshot: composition,
            mode: 'schema-only',
            purpose: 'stabilization-1249-promotion-eligible-subset',
          });
          yield* isolated.assertClonedSchema();
          const fixture = yield* makeNativeReadTestContext({
            connections: {
              admin: { connectionString: Redacted.make(isolated.connections.admin.connectionString) },
              runtime: { connectionString: Redacted.make(isolated.connections.runtime.connectionString) },
            },
            contextPermissions: ['pricing.promotion.subset.native_test.read'],
            moduleId: 'commerce.pricing',
            ownerFixtureRetention: 'retain-complete-context',
          });
          const fixtureContext = yield* Layer.build(fixture.layer);
          const prepared = yield* fixture
            .prepareOwner(
              Effect.fn('test.prepareNativePromotionSubset')(function* prepareNativeSubset(transaction, scope) {
                const raw = yield* produceMixedCandidate(transaction, scope);
                const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
                yield* approve(persistence, raw, scope);
                const absent = yield* readFloor(persistence, raw);
                expect(absent.evaluated).toMatchObject({
                  kind: 'ZERO_FLOOR_FAILED',
                  reasonCode: 'AUTHORIZATION_ABSENT',
                });
                yield* create(persistence, raw, scope);
                return raw;
              }),
            )
            .pipe(Effect.provideContext(fixtureContext));
          const before = yield* fixture.evidenceCount();
          expect(
            yield* fixture.runtime
              .runRead({
                input: prepared,
                principal: fixture.principal,
                registration: governedRead,
                transport: { correlationId: 'native-1249:governed-success' },
              })
              .pipe(Effect.provideContext(fixtureContext)),
          ).toEqual({ total: '90', values: ['90', '0'] });
          expect(yield* fixture.evidenceCount()).toBe(before + 1);
          yield* isolated.assertClonedSchema();
        }).pipe(Effect.provideContext(services));
      }),
    ),
  120_000,
);
