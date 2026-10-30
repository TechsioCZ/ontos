import { PricingPurposeEquivalenceResponseSchema } from '@app/catalog/api/pricing-purpose-equivalence';
import { QuantityBasisCompatibilityResponseSchema } from '@app/catalog/api/quantity-basis-compatibility';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { PricingCurrentMarketEvidenceResponseSchema } from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import { executePricingCurrentMarketEvidenceWithAuthorization } from '@app/commerce-market-catalog/api/pricing-current-market-evidence-client';
import { makeMarketRevisionNativeFixture } from '@app/commerce-market-catalog/testing/market-revision-native';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { PricingEvaluationAttemptSchema } from '@app/pricing-contracts/domain/material-change';
import {
  PricingExactPriceOwnerReadReceiptSchema,
  PricingMaterialEvidenceFenceSourceSchema,
} from '@app/pricing-contracts/domain/material-evidence';
import { QuantityTierSelectionInputSchema } from '@app/pricing-contracts/domain/quantity-tier';
import { PricingUnitPriceCalculationAttemptSchema } from '@app/pricing-contracts/domain/unit-price-calculation';
import {
  PricingCommercialFeeCalculationInputSchema,
  pricingCommercialFeeCurrentSetPredicateRef,
} from '@app/pricing-contracts/domain/commercial-fee';
import { PricingZeroFloorCurrentAuthorizationSetSchema } from '@app/pricing-contracts/domain/line-composition';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { Clock, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';

import { makeCurrentPricingDecisionExternalOwnerEvidenceLivePort } from '../../src/integrations/current-pricing-decision-external-owner-evidence-live.ts';
import { makeCurrentPricingDecisionWholeComposition } from '../../src/integrations/current-pricing-decision-whole-evaluation-adapters.ts';
import { makePricingCurrentDecisionMarketOwnerFinalFenceGateway } from '../../src/integrations/current-pricing-decision-owner-final-fence.ts';
import { makePricingMaterialEvidenceOwnerFinalFenceFromGateways } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import type { PricingOwnerMaterialEvidenceFenceGateway } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import { makePromotionModuleNotInstalledFinalFenceGateway } from '../../src/integrations/promotion-module-not-installed-final-fence.ts';
import { PricingCommercialContextUnavailable } from '../../shared/domain/pricing-commercial-context-unavailable.ts';
import { makeCurrentPricingDecisionWholeEvaluationService } from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import { makeCurrentPricingDecisionEvaluationService } from '../../src/services/current-pricing-decision-evaluation.service.ts';
import {
  makePricingExternalOwnerEvidenceValidationService,
  PricingExternalOwnerEvidenceValidation,
} from '../../src/services/external-owner-evidence-validation.service.ts';
import { PricingMaterialEvidenceOwnerFinalFence } from '../../src/services/material-evidence-final-validation.service.ts';
import type {
  PricingMaterialEvidenceFenceExpectation,
  PricingMaterialEvidenceFenceSourceObservation,
} from '../../src/services/material-evidence-final-validation.service.ts';
import { publishOrdinaryCurrentPricingForCustomer } from '../../src/services/ordinary-current-pricing-publication.service.ts';
import { CommercialFeeSetAuthoritySchema } from '../../src/services/commercial-fee-persistence.service.ts';
import {
  unitPriceCalculationAttempt,
  unitPriceFixtureTenantId,
  unitPriceFixtureEffectiveAt,
} from '../unit/support/unit-price-calculation.fixture.ts';
import { authorizationSetFor } from '../unit/support/issue-779-line-value.fixture.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
type MarketFixture = Effect.Success<ReturnType<typeof makeMarketRevisionNativeFixture>>;

// These are explicit non-Market owner preconditions, not claims that their native producers ran.
// Rebind the existing schema-checked arithmetic fixture to the disposable owner's exact scope/time.
const rebindPrecondition = (value: Schema.Json, replacements: readonly (readonly [string, string])[]): Schema.Json => {
  if (Schema.is(Schema.String)(value)) {
    let rebound = value;
    for (const [from, to] of replacements) {
      rebound = rebound.replaceAll(from, to);
    }
    return rebound;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rebindPrecondition(item, replacements));
  }
  if (Schema.is(Schema.Record(Schema.String, Schema.Json))(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rebindPrecondition(item, replacements)]),
    );
  }
  return value;
};

const preconditions = Effect.fn('MarketWholePricing1250.preconditions')(function* preconditions(
  owner: MarketFixture,
  channel: 'B2C' | 'B2B',
) {
  const at = DateTime.formatIso(owner.now);
  const requestedAt = DateTime.formatIso(owner.now);
  const replacements = [
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
    quantity: '1',
    tiers: [],
  });
  const encoded = yield* Schema.encodeEffect(PricingUnitPriceCalculationAttemptSchema)(initial);
  const json = yield* Schema.decodeUnknownEffect(Schema.Json)(encoded);
  const unit = yield* Schema.decodeUnknownEffect(PricingUnitPriceCalculationAttemptSchema)(
    rebindPrecondition(json, replacements),
  );
  assert('usedPrice' in unit.exactPrice.path);
  assert(unit.tierSelection.outcome === 'BASE_PRICE_RETAINED');
  assert(unit.lineQuantity !== undefined);
  assert(unit.quantityBasis.outcome === 'NO_CONVERSION_REQUIRED');
  const subject = {
    guestEvidenceRef: '1250:guest-evidence',
    guestSessionRef: '1250:guest-session',
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
        accessDecision: { decisionRef: '1250:access', decisionRevision: '1' },
        actor: subject,
        commercialSettingsDecision: { decisionRef: '1250:commercial-settings', decisionRevision: '1' },
        contextRef: '1250:purchase-context',
        contextRevision: '1',
        currencyResolution: { currencyCode: 'CZK', resolutionRef: '1250:currency', resolutionRevision: '1' },
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
      guestEvidenceAuthorityRef: '1250:guest-authority',
      guestSessionAuthorityRef: '1250:session-authority',
      kind: 'GUEST',
      subject,
      subjectAuthorityRevisionRef: '1',
    },
    verificationRef: '1250:purchase-context-verification',
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
      ownerRootRef: '1250:price-root',
      predicateRef: '1250:price-predicate',
      verificationRef: '1250:price-proof',
    },
    factProofs: [
      {
        factRef: used.priceRef.resourceId,
        factRevisionRef: used.priceRevision.revisionId,
        verificationRef: '1250:price-proof',
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
      attemptId: `1250:attempt:${ordinal}`,
      attemptOrdinal: ordinal,
      candidateRef: '1250:whole-candidate',
      completedAt: requestedAt,
      maxAttempts: 2,
      runId: '1250:run',
      snapshot: {
        attemptId: `1250:attempt:${ordinal}`,
        calculationVersions: {
          allocationContractVersions: [],
          arithmeticProfileVersions: ['pricing-czk-arithmetic:v1'],
          publicationProfileVersions: ['pricing-czk-publication:v1'],
        },
        candidateRef: '1250:whole-candidate',
        capturedAt: requestedAt,
        decision: request.decision,
        materialBindings: [
          {
            bindingRef: '1250:currency-support',
            kind: 'CURRENCY_SUPPORT',
            meaningRef: support.supportRevisionRef.resourceId,
            sourceEvidence: snapshotEvidence,
          },
        ],
        requestedAt,
        snapshotId: `1250:snapshot:${ordinal}`,
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
});

// Independently declared fixture evidence is decoded before it reaches the production builder.
// No caller-provided source, fact, or phase-one observation is used as an owner oracle.
type DeclaredSource = typeof PricingMaterialEvidenceFenceSourceSchema.Type;
const declaredExpectation = (source: DeclaredSource): PricingMaterialEvidenceFenceExpectation | undefined => {
  if (!('sourceEvidence' in source)) {
    return undefined;
  }
  const { completeness } = source.sourceEvidence;
  const expectation: PricingMaterialEvidenceFenceExpectation = {
    currentFacts: Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source.sourceEvidence)
      ? source.sourceEvidence.currentFacts.map(({ factRef, factRevisionRef, verification }) => ({
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
  if (completeness.currencyCode !== undefined) {
    Object.assign(expectation, { currencyCode: completeness.currencyCode });
  }
  if (completeness.temporal.nextMaterialBoundary !== undefined) {
    Object.assign(expectation, { nextMaterialBoundary: completeness.temporal.nextMaterialBoundary });
  }
  return expectation;
};
const orderedSources = (sources: readonly DeclaredSource[]) =>
  sources.toSorted((a, b) => a.verificationMaterial.kind.localeCompare(b.verificationMaterial.kind));
const orderedProofs = (sources: readonly PricingMaterialEvidenceFenceExpectation[]) =>
  sources.toSorted((a, b) => a.evidenceVerificationRef.localeCompare(b.evidenceVerificationRef));
const fixedPreconditionGateway = (
  declared: readonly DeclaredSource[],
  compositionRevision: string,
  nativeClock: Clock.Clock,
): PricingOwnerMaterialEvidenceFenceGateway => {
  const expectations = declared.flatMap((source) => {
    const expected = declaredExpectation(source);
    return expected === undefined ? [] : [expected];
  });
  let observed: readonly PricingMaterialEvidenceFenceSourceObservation[] | undefined;
  return {
    confirmObservedGenerationsThrough: (input) =>
      Effect.sync(() => {
        expect(input.candidateRef).toBe('1250:whole-candidate');
        expect(input.compositionRevision).toBe(compositionRevision);
        assert(input.typedSources !== undefined);
        expect(orderedSources(input.typedSources)).toEqual(orderedSources(declared));
        assert(observed !== undefined);
        expect(input.observations).toEqual(observed);
        return {
          confirmations: observed.map((observation) => ({
            currentFacts: observation.currentFacts,
            currentInvalidationGenerationRef: observation.currentInvalidationGenerationRef,
            currentOwnerSetRevisionRef: observation.currentOwnerSetRevisionRef,
            evidenceInvalidationGenerationRef: observation.evidenceInvalidationGenerationRef,
            evidenceVerificationRef: observation.evidenceVerificationRef,
          })),
          verifiedThrough: input.through,
        };
      }),
    verifyOpaqueProofsAgainstCurrentState: (input) =>
      Effect.gen(function* verifyDeclaredPreconditions() {
        expect(input.candidateRef).toBe('1250:whole-candidate');
        expect(input.compositionRevision).toBe(compositionRevision);
        assert(input.typedSources !== undefined);
        expect(orderedSources(input.typedSources)).toEqual(orderedSources(declared));
        expect(orderedProofs(input.sources)).toEqual(orderedProofs(expectations));
        const observedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis));
        observed = expectations.map((source) => ({
          ...source,
          currentInvalidationGenerationRef: `1250:fixed:${source.evidenceVerificationRef}`,
          currentOwnerSetRevisionRef: source.ownerSetRevisionRef,
          evidenceInvalidationGenerationRef: `1250:fixed:${source.evidenceVerificationRef}`,
          observedAt,
        }));
        return { completedAt: observedAt, observations: observed };
      }),
  };
};

const evaluateWhole = Effect.fn('MarketWholePricing1250.evaluateWhole')(function* evaluateWhole(
  owner: MarketFixture,
  channel: 'B2C' | 'B2B',
  nativeClock: Clock.Clock,
) {
  const setup = yield* preconditions(owner, channel);
  const { at, purchaseContextEvidence, request, requestedAt, unit } = setup;
  const selectedDefinitionRefs: string[] = [];
  const ordinals: number[] = [];
  const issuer = {
    issue: (input: Parameters<MarketFixture['issue']>[0]) =>
      owner.issue(input).pipe(
        Effect.mapError(
          () =>
            new PricingCommercialContextUnavailable({
              code: 'pricing_commercial_context_unavailable',
              reason: 'Owned native Market gateway is unavailable',
              retryable: true,
            }),
        ),
      ),
  };
  const execute: Parameters<typeof makePricingCurrentDecisionMarketOwnerFinalFenceGateway>[0]['execute'] = (
    payload,
    credential,
    correlation,
    options,
  ) =>
    executePricingCurrentMarketEvidenceWithAuthorization(
      payload,
      Redacted.value(credential),
      correlation,
      options,
    ).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          if (response.outcome === 'PRICING_MARKET_SOURCE_PRESENT') {
            selectedDefinitionRefs.push(response.market.definitionRevisionRef.resourceId);
          }
        }),
      ),
      Effect.flatMap(Schema.encodeEffect(PricingCurrentMarketEvidenceResponseSchema)),
    );
  const validation = makePricingExternalOwnerEvidenceValidationService();
  const composition = makeCurrentPricingDecisionWholeComposition();
  const { line } = unit;
  const catalogRequest = {
    anchorSelection: line.catalog.selection,
    effectiveAt: at,
    members: [{ handoff: line.catalog, occurrenceId: line.occurrenceId }],
  };
  const catalogResponse = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceResponseSchema)({
    assessments: [
      { handoff: line.catalog, role: 'ANCHOR' },
      ...catalogRequest.members.map((member) => ({ ...member, role: 'MEMBER' })),
    ],
    currentness: { effectiveAt: at, observedAt: at, status: 'CURRENT', validThrough: '2099-01-01T00:00:00.000Z' },
    currentnessEvidence: {
      effectiveAt: at,
      generation: '1250:catalog-generation',
      observedAt: at,
      predicateRef: '1250:catalog-equivalence',
      revalidatedAt: at,
      validThrough: '2099-01-01T00:00:00.000Z',
      verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
    },
    evidence: {
      anchorSelection: line.catalog.selection,
      assessmentId: '1250:catalog-assessment',
      effectiveAt: at,
      members: catalogRequest.members.map(({ occurrenceId }) => ({ occurrenceId, selection: line.catalog.selection })),
      observedAt: at,
      ownerModuleId: 'commerce.catalog',
      ownerRevision: '1250:catalog-owner',
      purpose: 'PRICING',
      status: 'CONFIRMED',
      validThrough: '2099-01-01T00:00:00.000Z',
    },
    generation: '1250:catalog-generation',
    outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
    verificationReceipt: {
      generation: '1250:catalog-generation',
      issuedAt: at,
      ownerModuleId: 'commerce.catalog',
      ownerRevision: '1250:catalog-owner',
      predicate: {
        anchor: {
          quantityBasis: line.catalog.quantityBasis,
          requestedQuantity: line.catalog.quantity.requested,
          selection: line.catalog.selection,
        },
        effectiveAt: at,
        members: catalogRequest.members.map(({ occurrenceId }) => ({
          occurrenceId,
          quantityBasis: line.catalog.quantityBasis,
          requestedQuantity: line.catalog.quantity.requested,
          selection: line.catalog.selection,
        })),
        purpose: 'PRICING',
      },
      predicateRef: '1250:catalog-equivalence',
      verificationRef: '1250:catalog-equivalence-proof',
    },
  }).pipe(Effect.orDie);
  const feeTarget = { variantRef: line.catalog.selection.variantRef };
  const feePredicate = pricingCommercialFeeCurrentSetPredicateRef({
    commercialScope: request.decision.commercialScope,
    currencyCode: 'CZK',
    target: feeTarget,
  });
  const feeAuthority = yield* Schema.decodeEffect(CommercialFeeSetAuthoritySchema)({
    generation: 1,
    observedAt: requestedAt,
    ownerRevision: '1250:fee-set',
    ownerRootRef: '1250:fee-root',
    predicateRef: feePredicate,
    verificationRef: '1250:fee-proof',
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
  // Fixed source identities and fact revisions come from the original decoded prerequisite receipts.
  const setEvidence = (
    authority: {
      nextApplicabilityBoundary?: string;
      observedAt: string;
      ownerRevision: string;
      ownerRootRef: string;
      predicateRef: string;
      verificationRef: string;
    },
    family: string,
    facts: readonly {
      effectivePeriod: { effectiveFrom: string; effectiveTo: string | null };
      factRef: string;
      factRevisionRef: string;
      verificationRef: string;
    }[],
    currencyCode?: string,
    ownerModuleId = 'commerce.pricing',
    declaredCompleteness?: typeof PricingSourceEvidenceVerifiedPresentSchema.Type.completeness.completenessEvidence,
    ownerEvaluation?: { evaluatedAt: string; evaluationMode: string },
  ) => {
    const ownerScope = {
      ownerModuleId,
      ownerRootRef: authority.ownerRootRef,
      predicateRef: authority.predicateRef,
      tenantId: owner.tenantId,
    };
    const currency = {};
    if (currencyCode !== undefined) {
      Object.assign(currency, { currencyCode });
    }
    const completenessEvidence = declaredCompleteness ?? {
      observedAt: authority.observedAt,
      ownerRevision: authority.ownerRevision,
      scope: { kind: 'EXACT_PREDICATE', predicateRef: authority.predicateRef },
    };
    if (declaredCompleteness === undefined && authority.nextApplicabilityBoundary !== undefined) {
      Object.assign(completenessEvidence, { nextApplicabilityBoundary: authority.nextApplicabilityBoundary });
    }
    const temporal = {
      effectiveAt: at,
      evaluatedAt: ownerEvaluation?.evaluatedAt ?? at,
      evaluationMode: ownerEvaluation?.evaluationMode ?? 'HISTORICAL_AS_OF',
      observedAt: authority.observedAt,
      requestedAt,
    };
    if (authority.nextApplicabilityBoundary !== undefined) {
      Object.assign(temporal, { nextMaterialBoundary: authority.nextApplicabilityBoundary });
    }
    const evidence = {
      _tag: facts.length === 0 ? 'VERIFIED_ABSENT' : 'VERIFIED_PRESENT',
      completeness: {
        ...currency,
        completenessEvidence,
        family,
        ownerScope,
        ownerSetRevisionRef: authority.ownerRevision,
        temporal,
        verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef: authority.verificationRef },
      },
      request: { ...currency, effectiveAt: at, family, ownerScope, requestedAt },
    };
    if (facts.length > 0) {
      Object.assign(evidence, {
        currentFacts: facts.map(({ verificationRef, ...fact }) => ({
          ...currency,
          ...fact,
          family,
          ownerScope,
          temporal,
          verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef },
        })),
      });
    }
    return evidence;
  };
  assert('usedPrice' in unit.exactPrice.path);
  const used = unit.exactPrice.path.usedPrice;
  const handoff = line.catalog;
  const catalogLineAuthority = {
    observedAt: handoff.completeness.observedAt,
    ownerRevision: handoff.completeness.ownerRevision,
    ownerRootRef: handoff.equivalentSelectionKey,
    predicateRef: handoff.completeness.scope.predicateRef,
    verificationRef: handoff.evidence.membership.attestationId,
  };
  if (handoff.completeness.nextApplicabilityBoundary !== undefined) {
    Object.assign(catalogLineAuthority, { nextApplicabilityBoundary: handoff.completeness.nextApplicabilityBoundary });
  }
  const pricingDeclarations = yield* Effect.forEach(
    [
      {
        sourceEvidence: setup.snapshotEvidence,
        verificationMaterial: { kind: 'PRICING_CURRENCY_SUPPORT_AUTHORITY', support: unit.exactPrice.currencySupport },
      },
      {
        sourceEvidence: setEvidence(
          setup.priceReceipt.authority,
          'PRICE',
          setup.priceReceipt.factProofs.map((proof) => ({
            ...proof,
            effectivePeriod: setup.tierInput.attempt.exactPrice.price.effectivePeriod,
          })),
          'CZK',
        ),
        verificationMaterial: {
          kind: 'PRICING_PRICE_AUTHORITY',
          lookupRequest: used.request,
          ownerReadReceipt: setup.priceReceipt,
        },
      },
      {
        sourceEvidence: setEvidence(setup.tierInput.tierSet.authority, 'QUANTITY_TIER', [], 'CZK'),
        verificationMaterial: {
          kind: 'PRICING_QUANTITY_TIER_AUTHORITY',
          ownerReadReceipt: {
            authority: setup.tierInput.tierSet.authority,
            factProofs: setup.tierInput.tierSet.factProofs,
          },
          selectionInput: yield* Schema.encodeEffect(QuantityTierSelectionInputSchema)(setup.tierInput),
        },
      },
      {
        sourceEvidence: setEvidence(feeAuthority, 'COMMERCIAL_FEE', [], 'CZK'),
        verificationMaterial: {
          currentSet: feeSet,
          kind: 'PRICING_COMMERCIAL_FEE_AUTHORITY',
          ownerReadReceipt: { authority: feeAuthority, factProofs: [] },
        },
      },
    ],
    (source) => Schema.decodeUnknownEffect(PricingMaterialEvidenceFenceSourceSchema)(source),
  );
  const catalogDeclarations = yield* Effect.forEach(
    [
      {
        sourceEvidence: setEvidence(
          catalogLineAuthority,
          'COMMERCIAL_CONTEXT',
          handoff.evidence.basis.map(({ source }) => ({
            effectivePeriod: {
              effectiveFrom: handoff.evidence.assessedAt,
              effectiveTo: handoff.evidence.validUntil ?? null,
            },
            factRef: source.resourceRef.resourceId,
            factRevisionRef: source.revisionId ?? String(source.revision),
            verificationRef: handoff.evidence.membership.attestationId,
          })),
          undefined,
          'commerce.catalog',
          handoff.completeness,
          { evaluatedAt: handoff.evidence.assessedAt, evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' },
        ),
        verificationMaterial: {
          compatibilityRequest: {
            effectiveAt: handoff.evidence.assessedAt,
            handoff,
            price: {
              quantity: line.pricingBasis.quantity,
              quantityBasis: {
                ...handoff.quantityBasis,
                targetRef: handoff.selection.packageOption?.optionRef ?? handoff.selection.variantRef,
                unitRef: line.pricingBasis.unitRef,
              },
            },
          },
          compatibilityResponse: setup.quantityBasis.evidence,
          handoff,
          kind: 'CATALOG_LINE_AUTHORITY',
          line,
          request: { amount: handoff.quantity.requested, purpose: 'PRICING', selection: handoff.selection },
        },
      },
      {
        sourceEvidence: setEvidence(
          {
            nextApplicabilityBoundary: '2099-01-01T00:00:00.000Z',
            observedAt: at,
            ownerRevision: '1250:catalog-owner',
            ownerRootRef: '1250:catalog-assessment',
            predicateRef: '1250:catalog-equivalence',
            verificationRef: '1250:catalog-equivalence-proof',
          },
          'COMMERCIAL_CONTEXT',
          [
            {
              effectivePeriod: { effectiveFrom: at, effectiveTo: '2099-01-01T00:00:00.000Z' },
              factRef: '1250:catalog-assessment',
              factRevisionRef: '1250:catalog-generation',
              verificationRef: '1250:catalog-equivalence-proof',
            },
          ],
          undefined,
          'commerce.catalog',
        ),
        verificationMaterial: {
          kind: 'CATALOG_EQUIVALENCE_AUTHORITY',
          request: catalogRequest,
          response: catalogResponse,
        },
      },
    ],
    (source) => Schema.decodeUnknownEffect(PricingMaterialEvidenceFenceSourceSchema)(source),
  );
  const purchaseDeclarations = [
    yield* Schema.decodeUnknownEffect(PricingMaterialEvidenceFenceSourceSchema)({
      verificationMaterial: {
        evidence: purchaseContextEvidence,
        kind: 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY',
        request: {
          actor: { kind: 'GUEST' },
          operationTime: at,
          purchasingContext: { ...request.decision.purchasingContext, ...request.decision.commercialScope },
          subject: request.subject,
          tenantId: owner.tenantId,
        },
      },
    }),
  ];
  const live = makeCurrentPricingDecisionExternalOwnerEvidenceLivePort(
    {
      compositionRevision: owner.compositionRevision,
      legalEntityId: owner.legalEntityId,
      requestCorrelation: '1250:whole-pricing',
      tenantId: owner.tenantId,
    },
    {
      applicationComposition: { load: Effect.succeed(owner.snapshot) },
      catalog: {
        execute: (input) =>
          Effect.sync(() => {
            expect(input).toEqual(catalogRequest);
            return catalogResponse;
          }),
        executeCompatibility: () =>
          Schema.decodeUnknownEffect(QuantityBasisCompatibilityResponseSchema)(setup.quantityBasis.evidence).pipe(
            Effect.orDie,
          ),
        issuer: {
          issue: () =>
            Effect.succeed({
              baseUrl: new URL('https://1250-precondition.invalid'),
              credential: Redacted.make('1250:declared-catalog-precondition'),
            }),
        },
      },
      customerContext: {
        execute: () => Effect.die('Guest precondition must not query a profile Price Group'),
        issuer: { issue: () => Effect.die('Guest precondition must not acquire a profile credential') },
      },
      market: { execute, issuer },
      validation,
    },
  );
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
    externalOwnerEvidence: live,
    feeReader: {
      loadCurrent: (_request, _attempt, price) =>
        Effect.gen(function* emptyFeePrecondition() {
          assert('usedPrice' in price.input.exactPrice.path);
          const authority = feeAuthority;
          const input = yield* Schema.decodeUnknownEffect(PricingCommercialFeeCalculationInputSchema)({
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
          return { authority, factProofs: [], input };
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
                ownerRootRef: '1250:floor-root',
                predicateRef: authorizationSet.exactPredicateRef,
                verificationRef: '1250:floor-proof',
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
  const fence = makePricingMaterialEvidenceOwnerFinalFenceFromGateways(
    {
      'commerce.catalog': fixedPreconditionGateway(catalogDeclarations, owner.compositionRevision, nativeClock),
      'commerce.customer-context': fixedPreconditionGateway(
        purchaseDeclarations,
        owner.compositionRevision,
        nativeClock,
      ),
      'commerce.market-catalog': makePricingCurrentDecisionMarketOwnerFinalFenceGateway({ execute, issuer }),
      'commerce.pricing': fixedPreconditionGateway(pricingDeclarations, owner.compositionRevision, nativeClock),
      'commerce.promotion': makePromotionModuleNotInstalledFinalFenceGateway(Effect.succeed(owner.snapshot)),
    },
    owner.compositionRevision,
  );
  const evaluation = makeCurrentPricingDecisionEvaluationService(service, (input) =>
    publishOrdinaryCurrentPricingForCustomer(input).pipe(
      Effect.provideService(PricingExternalOwnerEvidenceValidation, validation),
      Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, fence),
    ),
  );
  const result = yield* evaluation.evaluate(request, {
    purchaseContextEvidence,
    sellingLegalEntityId: owner.legalEntityId,
    tenantId: owner.tenantId,
  });
  return { ordinals, result, selectedDefinitionRefs };
});

it.layer(nativeServices, { excludeTestServices: true })((suite) =>
  suite.effect(
    'whole Current Pricing publishes exact same-Market R1 then public cosmetic R2 and bounds a real owner refusal (#1250)',
    () =>
      Effect.gen(function* wholeMarketRevisionAcceptance() {
        const nativeClock = yield* Clock.Clock;
        const owner = yield* makeMarketRevisionNativeFixture();
        const r1 = yield* owner.createR1();
        const first = yield* evaluateWhole(owner, 'B2C', nativeClock);
        expect(first.result).toMatchObject({ kind: 'PRICE_RESOLVED' });
        expect(first.ordinals).toEqual([1]);
        expect(first.selectedDefinitionRefs.length).toBeGreaterThan(1);
        expect(first.selectedDefinitionRefs.every((ref) => ref === r1.definitionRevisionRef.resourceId)).toBe(true);
        const r2 = yield* owner.reviseR2(r1);
        const second = yield* evaluateWhole(owner, 'B2C', nativeClock);
        expect(second.result).toMatchObject({ kind: 'PRICE_RESOLVED' });
        expect(second.ordinals).toEqual([1]);
        expect(second.selectedDefinitionRefs.length).toBeGreaterThan(1);
        expect(second.selectedDefinitionRefs.every((ref) => ref === r2.definitionRevisionRef.resourceId)).toBe(true);
        const refused = yield* evaluateWhole(owner, 'B2B', nativeClock);
        expect(refused.ordinals).toEqual([1, 2]);
        expect(refused.result).toMatchObject({
          kind: 'NON_RESOLVED',
          outcome: {
            inabilityEvidence: { attempts: 2 },
            outcome: 'PRICING_INDETERMINATE',
            reasonCode: 'CURRENTNESS_UNVERIFIABLE',
            retryable: true,
          },
        });
        expect(refused.selectedDefinitionRefs).toEqual([]);
      }).pipe(Effect.scoped),
  ),
);
