import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import type { CurrentPricingDecisionRequest } from '@app/pricing-contracts/current-pricing-decision';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { PRICING_CZK_PUBLICATION_PROFILE } from '@app/pricing-contracts/domain/exact-decimal';
import type { PricingRawCompositionReady } from '@app/pricing-contracts/domain/line-composition';
import { Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  buildCurrentPricingDiscountNonSelection,
  currentPricingDecisionWholeEvaluationAdaptersForScope,
  currentPricingDecisionWholeEvaluationForScope,
  makeCurrentPricingDecisionAttemptSource,
  makeCurrentPricingDecisionZeroFloorSetReader,
} from '../../src/integrations/current-pricing-decision-whole-evaluation-adapters.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import {
  makePricingExternalOwnerEvidenceValidationService,
  PricingExternalOwnerEvidenceValidation,
} from '../../src/services/external-owner-evidence-validation.service.ts';
import {
  CurrentPricingDecisionAttemptSource,
  CurrentPricingDecisionDiscountSetReader,
  CurrentPricingDecisionExternalOwnerEvidence,
  CurrentPricingDecisionFeeSetReader,
  CurrentPricingDecisionOwnerReadFailure,
  CurrentPricingDecisionTierSetReader,
  CurrentPricingDecisionWholeComposition,
  CurrentPricingDecisionZeroFloorSetReader,
} from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import { ExactPriceResolver } from '../../src/services/exact-price-resolution.service.ts';
import { PricingPromotionCurrentEvaluation } from '../../src/services/promotion-current-evaluation.service.ts';
import type { ZeroFloorAuthorizationPersistence } from '../../src/services/zero-floor-authorization-persistence.service.ts';
import {
  authorizationSetFor,
  candidateRef,
  firstRawLine,
  makeIssue779PreRoundScenario,
  makeIssue779Scenario,
  money,
} from './support/issue-779-line-value.fixture.ts';
import { composePricingRawLines } from '../../src/services/line-value-composition.service.ts';
import { unitPriceCalculationAttempt } from './support/unit-price-calculation.fixture.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authContextRef: 'better-auth-session:current-pricing-decision-adapters',
    authMethod: 'session',
    legalEntityId,
    principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId,
  }),
  correlationId: 'current-pricing-decision-adapters',
};

// SAFETY: The focused adapter test reaches only `invoke`; table operations and the private transaction marker are never observed.
const transaction = scopedRoutineInvokerFromTransaction(() => Effect.succeed([]), {
  legalEntityId,
  tenantId,
}) as unknown as ScopedTransactionExecutor;

const externalOwnerEvidenceValidation = makePricingExternalOwnerEvidenceValidationService();

const adaptersForScope = () =>
  currentPricingDecisionWholeEvaluationAdaptersForScope(transaction, scope).pipe(
    Effect.provideService(PricingExternalOwnerEvidenceValidation, externalOwnerEvidenceValidation),
  );

const evaluationForScope = () =>
  currentPricingDecisionWholeEvaluationForScope(transaction, scope).pipe(
    Effect.provideService(PricingExternalOwnerEvidenceValidation, externalOwnerEvidenceValidation),
  );

const assignedCommercialTotal = Effect.fn('test.assignedCommercialTotal')(function* assignedCommercialTotalProgram() {
  const { preRound } = yield* makeIssue779PreRoundScenario();
  const [line] = preRound.lines;
  if (line === undefined) {
    return yield* Effect.die(new Error('Assigned Discount fixture requires one line'));
  }
  const result = yield* calculatePricingCommercialTotals({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: [
      {
        occurrenceId: line.occurrenceId,
        publicationProfile: PRICING_CZK_PUBLICATION_PROFILE,
        publishedLineValue: money(line.nonNegativePreRoundValue.amount),
        roundingAdjustment: money('0'),
      },
    ],
  });
  if (result.outcome !== 'COMMERCIAL_TOTAL_READY') {
    return yield* Effect.die(new Error('Assigned Discount fixture requires a ready commercial total'));
  }
  return result;
});

const profileSubject = {
  authorizationSubject: { kind: 'RETAIL' as const },
  kind: 'PROFILE' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: 'profile:adapter-790',
    resourceType: 'commerce.customer-context.retail-customer-profile' as const,
    tenantId,
  },
};

const guestSubject = {
  guestEvidenceRef: 'guest-evidence:adapter-790',
  guestSessionRef: 'guest-session:adapter-790',
  kind: 'GUEST' as const,
};

const decisionForSubject = (
  decision: CurrentPricingDecisionRequest['decision'],
  subject: CurrentPricingDecisionRequest['subject'],
): CurrentPricingDecisionRequest['decision'] => ({
  ...decision,
  purchasingContext: {
    ...decision.purchasingContext,
    actor:
      subject.kind === 'GUEST'
        ? {
            guestEvidenceRef: subject.guestEvidenceRef,
            guestSessionRef: subject.guestSessionRef,
            kind: 'GUEST',
          }
        : { kind: 'PRINCIPAL', principalId: scope.principalId },
    subject,
  },
});

const exactPriceAuthority = {
  generation: 7,
  kind: 'PERSISTENT' as const,
  observedAt: '2026-09-28T12:00:00.000Z',
  ownerRevision: 'price-candidate-set:revision:adapter-790',
  ownerRootRef: 'price-candidate-set:root:adapter-790',
  predicateRef: 'price-candidate-set:predicate:adapter-790',
  verificationRef: 'price-candidate-set:verification:adapter-790',
};

const virtualEmptyPriceAuthority = {
  generation: 0 as const,
  kind: 'VIRTUAL_EMPTY' as const,
  observedAt: '2026-09-28T12:00:00.000Z',
  ownerRevision: 'price-candidate-set:empty:adapter-790',
  ownerRootRef: 'price-candidate-set:root:adapter-790',
  predicateRef: 'price-candidate-set:predicate:empty:adapter-790',
  verificationRef: 'price-candidate-set:verification:empty:adapter-790',
};

type PurchaseContextSubjectAuthorityInput =
  | {
      readonly guestEvidenceAuthorityRef: string;
      readonly guestSessionAuthorityRef: string;
      readonly kind: 'GUEST';
      readonly subject: CurrentPricingDecisionRequest['subject'];
      readonly subjectAuthorityRevisionRef: string;
    }
  | {
      readonly actorPrincipalId: string;
      readonly kind: 'PROFILE';
      readonly partyAuthorityRef: string;
      readonly partyAuthorityRevisionRef: string;
      readonly subject: CurrentPricingDecisionRequest['subject'];
      readonly subjectAuthorityRef: string;
      readonly subjectAuthorityRevisionRef: string;
    };

const evidenceFor = (request: CurrentPricingDecisionRequest, subjectAuthority: PurchaseContextSubjectAuthorityInput) =>
  Schema.decodeUnknownSync(PricingPurchaseContextVerificationEvidenceSchema)({
    actingPrincipalId: scope.principalId,
    currentness: {
      evaluatedAt: request.decision.operationTime,
      observedAt: request.decision.operationTime,
      validFrom: request.decision.operationTime,
      validTo: null,
    },
    ownerRef: request.decision.purchasingContext.contextRef,
    ownerRevisionRef: request.decision.purchasingContext.contextRevision,
    subjectAuthority,
    verificationRef: 'purchase-context-verification:discount-nonselection:790',
    verifiedScope: {
      channelId: request.decision.commercialScope.channelId,
      legalEntityId: request.decision.commercialScope.sellingLegalEntityId,
      marketId: request.decision.commercialScope.marketId,
      tenantId: request.decision.tenantId,
    },
  });

const attemptSourceScenario = Effect.fn('test.attemptSourceScenario')(function* attemptSourceScenario(
  kind: 'ABSENT' | 'RESOLVED',
) {
  const unitPriceAttempt = yield* unitPriceCalculationAttempt({ groupPath: false, quantity: '1' });
  const { exactPrice, line, quantityBasis } = unitPriceAttempt;
  if (!('usedPrice' in exactPrice.path)) {
    return yield* Effect.die(new Error('Adapter fixture requires one exact no-group Price'));
  }
  if (quantityBasis.outcome !== 'NO_CONVERSION_REQUIRED' && quantityBasis.outcome !== 'COMPATIBLE_CONVERSION') {
    return yield* Effect.die(new Error('Adapter fixture requires a successful Catalog Quantity-basis assessment'));
  }
  const { usedPrice } = exactPrice.path;
  const { exactKey } = usedPrice.request;
  const selector =
    exactKey.priceGroupSelector.kind === 'NO_GROUP' ? 'none' : exactKey.priceGroupSelector.priceGroupRef.resourceId;
  const predicateRef = [
    'pricing-exact-price',
    exactKey.catalogSelection.productRef.tenantId,
    exactKey.catalogSelection.variantRef.resourceId,
    exactKey.commercialScope.sellingLegalEntityId,
    exactKey.commercialScope.channelId,
    exactKey.commercialScope.marketId,
    exactKey.currencyCode,
    exactKey.unitBasis.unitRef.resourceId,
    exactKey.unitBasis.quantity,
    selector,
  ]
    .map(encodeURIComponent)
    .join(':');
  const authority = kind === 'RESOLVED' ? exactPriceAuthority : virtualEmptyPriceAuthority;
  const expectedAuthority =
    usedPrice.evidence.nextApplicabilityBoundary === undefined
      ? {
          ...authority,
          observedAt: usedPrice.evidence.observedAt,
          ownerRevision: usedPrice.evidence.ownerRevision,
          predicateRef,
        }
      : {
          ...authority,
          nextApplicabilityBoundary: usedPrice.evidence.nextApplicabilityBoundary,
          observedAt: usedPrice.evidence.observedAt,
          ownerRevision: usedPrice.evidence.ownerRevision,
          predicateRef,
        };
  const expectedFactProofs =
    kind === 'RESOLVED'
      ? [
          {
            factRef: usedPrice.priceRef.resourceId,
            factRevisionRef: usedPrice.priceRevision.revisionId,
            verificationRef: expectedAuthority.verificationRef,
          },
        ]
      : [];
  const resolution =
    kind === 'RESOLVED'
      ? exactPrice
      : {
          _tag: 'NO_APPLICABLE_PRICE' as const,
          currencySupport: exactPrice.currencySupport,
          path: {
            _tag: 'NO_APPLICABLE_PRICE' as const,
            noGroupAbsence: { _tag: 'ABSENT' as const, evidence: usedPrice.evidence, request: usedPrice.request },
            resolutionInput: exactPrice.path.resolutionInput,
          },
        };
  const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
    decision: {
      commercialScope: usedPrice.request.exactKey.commercialScope,
      currencyCode: usedPrice.request.exactKey.currencyCode,
      lines: [line],
      monetaryBoundary: 'PRE_TAX',
      operationTime: usedPrice.request.effectiveAt,
      purchasingContext: {
        accessDecision: {
          decisionRef: `access-decision:adapter-790:${kind.toLowerCase()}`,
          decisionRevision: 'access-decision-revision:adapter-790',
        },
        actor: guestSubject,
        commercialSettingsDecision: {
          decisionRef: `commercial-settings-decision:adapter-790:${kind.toLowerCase()}`,
          decisionRevision: 'commercial-settings-decision-revision:adapter-790',
        },
        contextRef: `purchase-context:adapter-790:${kind.toLowerCase()}`,
        contextRevision: 'purchase-context-revision:adapter-790',
        currencyResolution: {
          currencyCode: usedPrice.request.exactKey.currencyCode,
          resolutionRef: `currency-resolution:adapter-790:${kind.toLowerCase()}`,
          resolutionRevision: 'currency-resolution-revision:adapter-790',
        },
        subject: guestSubject,
      },
      tenantId: usedPrice.priceRef.tenantId,
    },
    subject: guestSubject,
  });
  const candidateSetReads: unknown[] = [];
  const source = makeCurrentPricingDecisionAttemptSource({
    catalogQuantity: {
      assess: () => Effect.succeed(quantityBasis.evidence),
    },
    exactPrice: { resolve: () => Effect.succeed(resolution) },
    interpreter: { interpret: () => Effect.die('Guest resolution must not consult Price Group interpretation') },
    loadCurrencySupport: () =>
      Effect.succeed({
        _tag: 'current' as const,
        current: {
          ...exactPrice.currencySupport,
          predicateRef: exactPrice.currencySupport.completenessEvidence.scope.predicateRef,
        },
      }),
    priceCandidateSets: {
      readExactCandidateSet: (query) => {
        candidateSetReads.push(query);
        return Effect.succeed(
          kind === 'RESOLVED'
            ? {
                authority: expectedAuthority,
                candidateSet: {
                  candidates: [
                    {
                      effectivePeriod: { effectiveFrom: usedPrice.priceRevision.effectiveFrom, effectiveTo: null },
                      exactKey: usedPrice.request.exactKey,
                      priceRef: usedPrice.priceRef,
                      priceRevision: usedPrice.priceRevision,
                      priceScheduleRevisionId: '77777777-7777-4777-8777-777777777790',
                      provenanceRefs: ['price-source:adapter-790'],
                      scheduleRevision: 1,
                    },
                  ],
                  effectiveAt: query.effectiveAt,
                  exactKey: query.exactKey,
                },
                factProofs: expectedFactProofs,
                outcome: 'EXACT_PRICE_CANDIDATE_SET_CURRENT' as const,
              }
            : {
                authority: expectedAuthority,
                candidateSet: { candidates: [], effectiveAt: query.effectiveAt, exactKey: query.exactKey },
                factProofs: expectedFactProofs,
                outcome: 'EXACT_PRICE_CANDIDATE_SET_CURRENT' as const,
              },
        );
      },
    },
  });
  const loaded = yield* source.loadFresh(
    request,
    {
      purchaseContextEvidence: evidenceFor(request, {
        guestEvidenceAuthorityRef: 'guest-evidence-authority:adapter-790',
        guestSessionAuthorityRef: 'guest-session-authority:adapter-790',
        kind: 'GUEST',
        subject: request.subject,
        subjectAuthorityRevisionRef: 'guest-authority-revision:adapter-790',
      }),
      sellingLegalEntityId: request.decision.commercialScope.sellingLegalEntityId,
      tenantId: request.decision.tenantId,
    },
    1,
  );
  return {
    candidateSetReads,
    exactLookupRequest: usedPrice.request,
    expectedAuthority,
    expectedFactProofs,
    loaded,
    request,
    resolution,
  };
});

describe('Current Pricing Decision whole-evaluation production adapters #790', () => {
  it.effect('reads one ordered ZERO_FLOOR Current set for each stable line meaning', () =>
    Effect.gen(function* perLineZeroFloorAuthority() {
      const firstFixture = yield* makeIssue779Scenario({
        discounts: ['40', '40', '40'],
        occurrenceId: 'line-790-floor-reader-a',
      });
      const secondFixture = yield* makeIssue779Scenario({
        discounts: ['40', '40', '40'],
        occurrenceId: 'line-790-floor-reader-b',
      });
      const firstRaw = yield* composePricingRawLines(firstFixture.compositionRequest);
      const secondRaw = yield* composePricingRawLines(secondFixture.compositionRequest);
      if (firstRaw.outcome !== 'RAW_COMPOSITION_READY' || secondRaw.outcome !== 'RAW_COMPOSITION_READY') {
        throw new Error('ZERO_FLOOR reader fixture requires two raw-negative lines');
      }
      const firstLine = firstRawLine(firstRaw.lines);
      const originalSecondLine = firstRawLine(secondRaw.lines);
      const secondPricingBasis = { ...originalSecondLine.line.pricingBasis, quantity: '2' };
      const secondDecisionLine = { ...originalSecondLine.line, pricingBasis: secondPricingBasis };
      const secondLine = {
        ...originalSecondLine,
        line: secondDecisionLine,
        unitPriceCalculation: {
          ...originalSecondLine.unitPriceCalculation,
          input: { ...originalSecondLine.unitPriceCalculation.input, line: secondDecisionLine },
        },
      };
      const composition: PricingRawCompositionReady = {
        ...firstRaw,
        decision: decisionForSubject(
          { ...firstRaw.decision, lines: [firstLine.line, secondDecisionLine] },
          {
            guestEvidenceRef: 'guest-evidence:adapter-790-floor-reader',
            guestSessionRef: 'guest-session:adapter-790-floor-reader',
            kind: 'GUEST',
          },
        ),
        lines: [firstLine, secondLine],
      };
      const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
        decision: composition.decision,
        subject: {
          guestEvidenceRef: 'guest-evidence:adapter-790-floor-reader',
          guestSessionRef: 'guest-session:adapter-790-floor-reader',
          kind: 'GUEST',
        },
      });
      const queries: Parameters<ZeroFloorAuthorizationPersistence['readCurrentSet']>[0][] = [];
      const readCurrentSet: ZeroFloorAuthorizationPersistence['readCurrentSet'] = ({ query }) => {
        queries.push({ query });
        const line = composition.lines.find(({ occurrenceId }) => query.exactPredicateRef.endsWith(occurrenceId));
        if (line === undefined) {
          return Effect.die(new Error('ZERO_FLOOR query lost its stable occurrence'));
        }
        const template = authorizationSetFor(line);
        const [templateAuthorization] = template.authorizations;
        if (templateAuthorization === undefined) {
          return Effect.die(new Error('ZERO_FLOOR fixture requires one authorization'));
        }
        const ownerRevision = `zero-floor-set:${line.occurrenceId}`;
        const verificationRef = `zero-floor-verification:${line.occurrenceId}`;
        const authorization = {
          ...templateAuthorization,
          authorizationRef: `zero-floor-authorization:${line.occurrenceId}`,
          authorizationRevision: `zero-floor-authorization-revision:${line.occurrenceId}`,
          businessScope: {
            catalogSelection: query.catalogSelection,
            commercialScope: query.commercialScope,
            pricingBasis: query.pricingBasis,
            tenantId: query.tenantId,
          },
          coveredMeaning: {
            audienceRefs: query.audienceRefs,
            materialRevisionRefs: query.materialRevisionRefs,
          },
          currencyCode: query.currencyCode,
        };
        return Effect.succeed({
          authority: {
            generation: 1,
            observedAt: query.effectiveAt,
            ownerRevision,
            ownerRootRef: `zero-floor-root:${line.occurrenceId}`,
            predicateRef: query.exactPredicateRef,
            verificationRef,
          },
          authorizationSet: {
            ...template,
            authorizations: [authorization],
            completenessEvidence: {
              observedAt: query.effectiveAt,
              ownerRevision,
              scope: { kind: 'EXACT_PREDICATE', predicateRef: query.exactPredicateRef },
            },
            currentness: {
              evaluatedAt: query.effectiveAt,
              observedAt: query.effectiveAt,
              revalidatedAt: query.effectiveAt,
              status: 'CURRENT',
            },
            exactPredicateRef: query.exactPredicateRef,
            ownerRevision,
            query,
          },
          factProofs: [
            {
              factRef: authorization.authorizationRef,
              factRevisionRef: authorization.authorizationRevision,
              verificationRef,
            },
          ],
          outcome: 'ZERO_FLOOR_AUTHORIZATION_SET_CURRENT',
        });
      };
      // SAFETY: This focused reader test invokes only readCurrentSet; every unrelated persistence method is unreachable.
      const reader = makeCurrentPricingDecisionZeroFloorSetReader({
        readCurrentSet,
      } as ZeroFloorAuthorizationPersistence);
      const { loaded } = yield* attemptSourceScenario('RESOLVED');
      const { attempt } = loaded;
      const reads = yield* reader.loadCurrent(request, attempt, composition);

      expect(reads.map(({ occurrenceId }) => occurrenceId)).toEqual([firstLine.occurrenceId, secondLine.occurrenceId]);
      expect(queries).toHaveLength(2);
      expect(queries.map(({ query }) => query.pricingBasis)).toEqual([
        firstLine.line.pricingBasis,
        secondLine.line.pricingBasis,
      ]);
      expect(queries.map(({ query }) => query.exactPredicateRef)).toEqual([
        expect.stringContaining(firstLine.occurrenceId),
        expect.stringContaining(secondLine.occurrenceId),
      ]);
      expect(queries.every(({ query }) => query.effectiveAt === request.decision.operationTime)).toBe(true);
      expect(
        reads.map(({ authorizationSet }) => {
          if ('failure' in authorizationSet) {
            return null;
          }
          const [authorization] = authorizationSet.authorizations;
          return authorization?.authorizationRef;
        }),
      ).toEqual([
        `zero-floor-authorization:${firstLine.occurrenceId}`,
        `zero-floor-authorization:${secondLine.occurrenceId}`,
      ]);
    }),
  );

  it.effect('binds exact Price candidate-set authority receipts for resolved and authoritative-absence paths', () =>
    Effect.gen(function* candidateSetReceipts() {
      const resolved = yield* attemptSourceScenario('RESOLVED');
      const absent = yield* attemptSourceScenario('ABSENT');

      expect(resolved.candidateSetReads).toEqual([
        {
          effectiveAt: resolved.exactLookupRequest.effectiveAt,
          exactKey: resolved.exactLookupRequest.exactKey,
        },
      ]);
      expect(resolved.loaded.exactPriceLines[0].priceCandidateSetAuthorities).toEqual([
        { authority: resolved.expectedAuthority, factProofs: resolved.expectedFactProofs },
      ]);
      expect(absent.candidateSetReads).toHaveLength(1);
      expect(absent.loaded.exactPriceLines[0].priceCandidateSetAuthorities).toEqual([
        { authority: absent.expectedAuthority, factProofs: [] },
      ]);
    }),
  );

  it.effect('builds canonical NO_APPLICABLE_PRICE only from the owner-proven absence path', () =>
    Effect.scoped(
      Effect.gen(function* ownerProvenAbsence() {
        const scenario = yield* attemptSourceScenario('ABSENT');
        const adapters = yield* adaptersForScope();
        const context = yield* Layer.build(adapters);
        const composition = Context.get(context, CurrentPricingDecisionWholeComposition);

        const outcome = yield* composition.buildNoApplicablePrice({
          attempt: scenario.loaded.attempt,
          exactPriceLines: scenario.loaded.exactPriceLines,
          request: scenario.request,
        });

        expect(outcome).toMatchObject({
          lookups: [{ lookup: { kind: 'NO_GROUP_ABSENT' }, status: 'ABSENT' }],
          outcome: 'NO_APPLICABLE_PRICE',
        });
        if (outcome.outcome !== 'NO_APPLICABLE_PRICE') {
          return yield* Effect.die(new Error('Owner-proven absence must produce canonical NO_APPLICABLE_PRICE'));
        }
        expect(outcome.proof.currentness.materialBindings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'ABSENCE',
              revisionRef: scenario.expectedAuthority.ownerRevision,
            }),
          ]),
        );
        return outcome;
      }),
    ),
  );

  it.effect('keeps ordinary Promotion unselected and exposes no fabricated Promotion success', () =>
    Effect.scoped(
      Effect.gen(function* ordinaryPromotion() {
        const { compositionRequest } = yield* makeIssue779Scenario();
        const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
          decision: decisionForSubject(compositionRequest.decision, guestSubject),
          subject: guestSubject,
        });
        const adapters = yield* adaptersForScope();
        const context = yield* Layer.build(adapters);
        const composition = Context.get(context, CurrentPricingDecisionWholeComposition);
        const scenario = yield* attemptSourceScenario('ABSENT');

        // SAFETY: Promotion non-selection does not inspect allocation after no Promotion source is selected.
        const selection = yield* composition.resolvePromotionRequirement({
          allocation: {} as never,
          attempt: scenario.loaded.attempt,
          request,
        });

        expect(selection).toEqual({ kind: 'PROMOTION_NOT_SELECTED' });
        expect('source' in selection).toBe(false);
      }),
    ),
  );

  it.effect('provides exactly the nine evaluator services from one owner-local aggregate Layer', () =>
    Effect.scoped(
      Effect.gen(function* aggregateLayer() {
        const adapters = yield* adaptersForScope();
        const context = yield* Layer.build(adapters);

        expect(Context.get(context, CurrentPricingDecisionAttemptSource).loadFresh).toBeTypeOf('function');
        expect(Context.get(context, CurrentPricingDecisionTierSetReader).loadCurrent).toBeTypeOf('function');
        expect(Context.get(context, CurrentPricingDecisionFeeSetReader).loadCurrent).toBeTypeOf('function');
        expect(Context.get(context, CurrentPricingDecisionDiscountSetReader).loadCurrent).toBeTypeOf('function');
        expect(Context.get(context, CurrentPricingDecisionExternalOwnerEvidence).loadFresh).toBeTypeOf('function');
        expect(Context.get(context, CurrentPricingDecisionZeroFloorSetReader).loadCurrent).toBeTypeOf('function');
        const composition = Context.get(context, CurrentPricingDecisionWholeComposition);
        expect(composition.buildPublicationInput).toBeTypeOf('function');
        expect(composition.resolvePromotionRequirement).toBeTypeOf('function');
        expect(Context.get(context, ExactPriceResolver).resolve).toBeTypeOf('function');
        expect(Context.get(context, PricingPromotionCurrentEvaluation).evaluate).toBeTypeOf('function');
      }),
    ),
  );

  it.effect('keeps missing atomic snapshot authority as an explicit typed unavailable result', () =>
    Effect.gen(function* typedUnavailable() {
      const { compositionRequest } = yield* makeIssue779Scenario();
      const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
        decision: decisionForSubject(compositionRequest.decision, guestSubject),
        subject: guestSubject,
      });
      const adapters = yield* adaptersForScope();
      const purchaseContextEvidence = yield* Schema.decodeEffect(PricingPurchaseContextVerificationEvidenceSchema)({
        currentness: {
          evaluatedAt: request.decision.operationTime,
          observedAt: request.decision.operationTime,
          validFrom: request.decision.operationTime,
          validTo: null,
        },
        ownerRef: request.decision.purchasingContext.contextRef,
        ownerRevisionRef: request.decision.purchasingContext.contextRevision,
        subjectAuthority: {
          guestEvidenceAuthorityRef: 'guest-evidence-authority:adapter-790',
          guestSessionAuthorityRef: 'guest-session-authority:adapter-790',
          kind: 'GUEST',
          subject: guestSubject,
          subjectAuthorityRevisionRef: 'guest-authority-revision:adapter-790',
        },
        verificationRef: 'purchase-context-verification:adapter-790',
        verifiedScope: {
          channelId: request.decision.commercialScope.channelId,
          legalEntityId: request.decision.commercialScope.sellingLegalEntityId,
          marketId: request.decision.commercialScope.marketId,
          tenantId: request.decision.tenantId,
        },
      });
      const unavailable = yield* Effect.scoped(
        Effect.gen(function* unavailableAttempt() {
          const context = yield* Layer.build(adapters);
          const source = Context.get(context, CurrentPricingDecisionAttemptSource);
          return yield* Effect.flip(
            source.loadFresh(
              request,
              {
                purchaseContextEvidence,
                sellingLegalEntityId: request.decision.commercialScope.sellingLegalEntityId,
                tenantId: request.decision.tenantId,
              },
              1,
            ),
          );
        }),
      );

      expect(Schema.is(CurrentPricingDecisionOwnerReadFailure)(unavailable)).toBe(true);
      expect(unavailable).toMatchObject({
        kind: 'UNAVAILABLE',
        ownerRefs: ['pricing-currency-support:current-set'],
      });
    }),
  );

  it.effect('does not encode an assigned Discount audience with retained contributions as nonselection', () =>
    Effect.gen(function* assignedAudience() {
      const commercialTotal = yield* assignedCommercialTotal();
      const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
        decision: commercialTotal.decision,
        subject: commercialTotal.decision.purchasingContext.subject,
      });
      const subjectEvidence = evidenceFor(request, {
        actorPrincipalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        kind: 'PROFILE',
        partyAuthorityRef: 'party-authority:adapter-790',
        partyAuthorityRevisionRef: 'party-authority-revision:adapter-790',
        subject: request.subject,
        subjectAuthorityRef: 'profile-authority:adapter-790',
        subjectAuthorityRevisionRef: 'profile-authority-revision:adapter-790',
      });

      const selection = yield* buildCurrentPricingDiscountNonSelection({
        commercialTotal,
        request,
        subjectEvidence,
      });

      expect(selection).toEqual({ kind: 'DISCOUNT_AUDIENCE_SELECTED' });
    }),
  );

  it.effect('rejects forged Guest CCC evidence for a Profile Discount audience decision', () =>
    Effect.gen(function* forgedGuestEvidence() {
      const commercialTotal = yield* assignedCommercialTotal();
      const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
        decision: commercialTotal.decision,
        subject: commercialTotal.decision.purchasingContext.subject,
      });
      const forgedGuest = {
        guestEvidenceRef: 'guest-evidence:forged:adapter-790',
        guestSessionRef: 'guest-session:forged:adapter-790',
        kind: 'GUEST' as const,
      };
      const subjectEvidence = evidenceFor(request, {
        guestEvidenceAuthorityRef: 'guest-evidence-authority:forged:adapter-790',
        guestSessionAuthorityRef: 'guest-session-authority:forged:adapter-790',
        kind: 'GUEST',
        subject: forgedGuest,
        subjectAuthorityRevisionRef: 'guest-authority-revision:forged:adapter-790',
      });

      const rejected = yield* Effect.flip(
        buildCurrentPricingDiscountNonSelection({ commercialTotal, request, subjectEvidence }),
      );

      expect(rejected).toMatchObject({
        kind: 'UNVERIFIABLE',
        ownerRefs: ['commerce-customer-context:discount-audience'],
      });
    }),
  );

  it.effect('rejects forged Profile CCC evidence for a Guest Discount audience decision', () =>
    Effect.gen(function* forgedProfileEvidence() {
      const commercialTotal = yield* assignedCommercialTotal();
      const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
        decision: decisionForSubject(commercialTotal.decision, guestSubject),
        subject: guestSubject,
      });
      const subjectEvidence = evidenceFor(request, {
        actorPrincipalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        kind: 'PROFILE',
        partyAuthorityRef: 'party-authority:forged:adapter-790',
        partyAuthorityRevisionRef: 'party-authority-revision:forged:adapter-790',
        subject: profileSubject,
        subjectAuthorityRef: 'profile-authority:forged:adapter-790',
        subjectAuthorityRevisionRef: 'profile-authority-revision:forged:adapter-790',
      });

      const rejected = yield* Effect.flip(
        buildCurrentPricingDiscountNonSelection({ commercialTotal, request, subjectEvidence }),
      );

      expect(rejected).toMatchObject({
        kind: 'UNVERIFIABLE',
        ownerRefs: ['commerce-customer-context:discount-audience'],
      });
    }),
  );

  it.effect('constructs the scoped whole evaluator without retaining a global transaction service', () =>
    Effect.gen(function* scopedWholeEvaluator() {
      const service = yield* evaluationForScope();
      expect(service.loadFresh).toBeTypeOf('function');
    }),
  );
});
