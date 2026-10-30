import { TestClock } from 'effect/testing';
import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import type { CurrentPricingDecisionRequest } from '@app/pricing-contracts/current-pricing-decision';
import {
  currentPricingDecisionCandidateRef,
  CurrentPricingDecisionRequestSchema,
} from '@app/pricing-contracts/current-pricing-decision';
import type { ExactPriceLookupCurrentEvidenceSchema } from '@app/pricing-contracts/domain/exact-price-lookup';
import { PRICING_CZK_PUBLICATION_PROFILE } from '@app/pricing-contracts/domain/exact-decimal';
import {
  PricingContractualDiscountCurrentSetSchema,
  PricingContractualDiscountSetPredicateSchema,
  pricingContractualDiscountSetPredicateRef,
} from '@app/pricing-contracts/domain/contractual-discount-set';
import { ScheduledPricingDiscountRevisionSchema } from '@app/pricing-contracts/domain/discount';
import type { PriceGroupAssignmentProfile } from '@app/pricing-contracts/domain/price-group-interpretation';
import { PricingSourceEvidenceVerifiedAbsentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { PricingEvaluationAttemptSchema } from '@app/pricing-contracts/domain/material-change';
import type { PricingRawCompositionReady } from '@app/pricing-contracts/domain/line-composition';
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Cause, Context, DateTime, Effect, Layer, Schema } from 'effect';
import { SqlError, UniqueViolation } from 'effect/sql/SqlError';
import { assert, describe, expect, it } from 'effect-rstest';

import {
  buildCurrentPricingDiscountNonSelection,
  buildCurrentPricingDiscountSourceEvidence,
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
import { verifyPreapprovalQuotationBinding } from '../../src/services/preapproval-quotation-verification.service.ts';
import { applyQuotationManagement, makeFreshCurrentResolver } from '../../src/actions/manage-quotation.action.ts';
import { ManageQuotationPayloadSchema } from '../../shared/actions/manage-quotation.ts';
import { pricingQuotationMatchesCurrentDecision } from '@app/pricing-contracts/quotation-verification';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';
import { composePricingRawLines } from '../../src/services/line-value-composition.service.ts';
import { unitPriceCalculationAttempt } from './support/unit-price-calculation.fixture.ts';
import { makeIssue787Snapshot } from './support/issue-787-material-change.fixture.ts';
import { calculatePricingUnitPrice } from '../../src/services/unit-price-calculation.service.ts';

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
  currentPricingDecisionWholeEvaluationAdaptersForScope(transaction, scope, 'a'.repeat(64)).pipe(
    Effect.provideService(PricingExternalOwnerEvidenceValidation, externalOwnerEvidenceValidation),
  );

const evaluationForScope = () =>
  currentPricingDecisionWholeEvaluationForScope(transaction, scope, 'a'.repeat(64)).pipe(
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

interface NativeLookupBridgeField {
  readonly lookupEvidence?: typeof ExactPriceLookupCurrentEvidenceSchema.Type;
}

const attemptSourceScenario = Effect.fn('test.attemptSourceScenario')(function* attemptSourceScenario(
  kind: 'ABSENT' | 'RESOLVED',
  bridge: 'CURRENT' | 'MISSING' | 'CHANGED_REVISION' | 'STALE' = 'CURRENT',
  mode: 'ORDINARY' | 'PREPROPOSAL' = 'ORDINARY',
) {
  const usePreproposal = mode === 'PREPROPOSAL';
  const options: Parameters<typeof unitPriceCalculationAttempt>[0] = { groupPath: usePreproposal, quantity: '1' };
  if (usePreproposal) {
    Object.assign(options, { occurrenceId: 'line-779' });
  }
  const unitPriceAttempt = yield* unitPriceCalculationAttempt(options);
  const { exactPrice, line, quantityBasis } = unitPriceAttempt;
  if (!('usedPrice' in exactPrice.path)) {
    return yield* Effect.die(new Error('Adapter fixture requires one exact no-group Price'));
  }
  if (quantityBasis.outcome !== 'NO_CONVERSION_REQUIRED' && quantityBasis.outcome !== 'COMPATIBLE_CONVERSION') {
    return yield* Effect.die(new Error('Adapter fixture requires a successful Catalog Quantity-basis assessment'));
  }
  const { usedPrice } = exactPrice.path;
  const authority = kind === 'RESOLVED' ? exactPriceAuthority : virtualEmptyPriceAuthority;
  const lookupEvidence = {
    ...usedPrice.evidence,
    observedAt: DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(usedPrice.evidence.observedAt), { milliseconds: 1 }),
    ),
  };
  if (bridge === 'CHANGED_REVISION') {
    Object.assign(lookupEvidence, { ownerRevision: 'native-exact:changed-material-state' });
  }
  if (bridge === 'STALE') {
    Object.assign(lookupEvidence, { observedAt: '2000-01-01T00:00:00.000Z' });
  }
  const expectedAuthority = {
    ...authority,
    observedAt: lookupEvidence.observedAt,
    predicateRef: 'commerce.pricing.exact-price-candidates:independent-owner-predicate',
  };
  const bridgeField: NativeLookupBridgeField = {};
  if (bridge !== 'MISSING') {
    Object.assign(bridgeField, { lookupEvidence });
  }
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
  const profileTemplate = usePreproposal ? yield* makeIssue779Scenario() : undefined;
  const subject = profileTemplate?.compositionRequest.decision.purchasingContext.subject ?? guestSubject;
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
        actor: usePreproposal ? { kind: 'PRINCIPAL', principalId: scope.principalId } : guestSubject,
        commercialSettingsDecision: {
          decisionRef: `commercial-settings-decision:adapter-790:${kind.toLowerCase()}`,
          decisionRevision: 'commercial-settings-decision-revision:adapter-790',
        },
        contextRef: usePreproposal
          ? 'ccc:preproposal:44444444-4444-4444-8444-444444444444'
          : `purchase-context:adapter-790:${kind.toLowerCase()}`,
        contextRevision: 'purchase-context-revision:adapter-790',
        currencyResolution: {
          currencyCode: usedPrice.request.exactKey.currencyCode,
          resolutionRef: `currency-resolution:adapter-790:${kind.toLowerCase()}`,
          resolutionRevision: 'currency-resolution-revision:adapter-790',
        },
        subject,
      },
      tenantId: usedPrice.priceRef.tenantId,
    },
    subject,
  });
  const candidateSetReads: unknown[] = [];
  const source = makeCurrentPricingDecisionAttemptSource({
    catalogQuantity: {
      assess: () => Effect.succeed(quantityBasis.evidence),
    },
    exactPrice: { resolve: () => Effect.succeed(resolution) },
    interpreter: {
      interpret: () =>
        'interpretation' in exactPrice.path.resolutionInput
          ? Effect.succeed(exactPrice.path.resolutionInput.interpretation)
          : Effect.die('Guest resolution must not consult Price Group interpretation'),
    },
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
                ...bridgeField,
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
                ...bridgeField,
                candidateSet: { candidates: [], effectiveAt: query.effectiveAt, exactKey: query.exactKey },
                factProofs: expectedFactProofs,
                outcome: 'EXACT_PRICE_CANDIDATE_SET_CURRENT' as const,
              },
        ).pipe(Effect.tap(() => TestClock.adjust(1)));
      },
    },
  });
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(exactPrice.currencySupport.observedAt)));
  const loaded = yield* source.loadFresh(
    request,
    {
      purchaseContextEvidence: evidenceFor(
        request,
        subject.kind === 'PROFILE'
          ? {
              actorPrincipalId:
                request.decision.purchasingContext.actor.kind === 'PRINCIPAL'
                  ? request.decision.purchasingContext.actor.principalId
                  : scope.principalId,
              kind: 'PROFILE',
              partyAuthorityRef: 'party:r1',
              partyAuthorityRevisionRef: 'party:r1:revision',
              subject,
              subjectAuthorityRef: 'profile:r1',
              subjectAuthorityRevisionRef: 'profile:r1:revision',
            }
          : {
              guestEvidenceAuthorityRef: 'guest-evidence-authority:adapter-790',
              guestSessionAuthorityRef: 'guest-session-authority:adapter-790',
              kind: 'GUEST',
              subject: request.subject,
              subjectAuthorityRevisionRef: 'guest-authority-revision:adapter-790',
            },
      ),
      sellingLegalEntityId: request.decision.commercialScope.sellingLegalEntityId,
      tenantId: request.decision.tenantId,
    },
    1,
  );
  expect(loaded.attempt.startedAt).toBe(exactPrice.currencySupport.observedAt);
  expect(loaded.attempt.snapshot.requestedAt).toBe(loaded.attempt.startedAt);
  expect(loaded.attempt.completedAt).toBe(
    DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(exactPrice.currencySupport.observedAt), { milliseconds: 1 })),
  );
  expect(loaded.attempt.snapshot.capturedAt).toBe(loaded.attempt.completedAt);
  return {
    candidateSetReads,
    exactLookupRequest: usedPrice.request,
    expectedAuthority,
    expectedFactProofs,
    loaded,
    lookupEvidence,
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
        const line = composition.lines.find(
          ({ line: decisionLine }) => decisionLine.pricingBasis.quantity === query.pricingBasis.quantity,
        );
        if (line === undefined) {
          return Effect.die(new Error('ZERO_FLOOR query lost its stable occurrence'));
        }
        const template = authorizationSetFor(line);
        const [templateAuthorization] = template.authorizations;
        if (templateAuthorization === undefined) {
          return Effect.die(new Error('ZERO_FLOOR fixture requires one authorization'));
        }
        const exactPredicateRef = `native-owner-predicate:${query.pricingBasis.quantity}`;
        const fullQuery = { ...query, exactPredicateRef };
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
            predicateRef: exactPredicateRef,
            verificationRef,
          },
          authorizationSet: {
            ...template,
            authorizations: [authorization],
            completenessEvidence: {
              observedAt: query.effectiveAt,
              ownerRevision,
              scope: { kind: 'EXACT_PREDICATE', predicateRef: exactPredicateRef },
            },
            currentness: {
              evaluatedAt: query.effectiveAt,
              observedAt: query.effectiveAt,
              revalidatedAt: query.effectiveAt,
              status: 'CURRENT',
            },
            exactPredicateRef,
            ownerRevision,
            query: fullQuery,
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
      expect(queries.every(({ query }) => !('exactPredicateRef' in query))).toBe(true);
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
        {
          authority: resolved.expectedAuthority,
          factProofs: resolved.expectedFactProofs,
          lookupEvidence: resolved.lookupEvidence,
        },
      ]);
      expect(absent.candidateSetReads).toHaveLength(1);
      expect(absent.loaded.exactPriceLines[0].priceCandidateSetAuthorities).toEqual([
        { authority: absent.expectedAuthority, factProofs: [], lookupEvidence: absent.lookupEvidence },
      ]);
    }),
  );

  it.effect('rejects missing native bindings, changed exact owner state, and stale observations (#1279)', () =>
    Effect.gen(function* invalidNativeProofBindings() {
      for (const bridge of ['MISSING', 'CHANGED_REVISION', 'STALE'] as const) {
        for (const kind of ['ABSENT', 'RESOLVED'] as const) {
          const failure = yield* attemptSourceScenario(kind, bridge).pipe(Effect.flip);
          expect(failure).toMatchObject({ kind: 'UNVERIFIABLE' });
        }
      }
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
              revisionRef: scenario.lookupEvidence.ownerRevision,
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

// Component regression only: Catalog/Price/CCC reads and the final-fence evaluator are injected.
// Candidate construction, line publication, totals, registered Action behavior and the exact
// verification used by basis completion execute real owner code; this is not native evidence.
const preproposalIssuanceScenario = Effect.fn('test.preproposalIssuanceScenario')(
  function* preproposalIssuanceScenario() {
    const { loaded, request } = yield* attemptSourceScenario('RESOLVED', 'CURRENT', 'PREPROPOSAL');
    const actualCandidateRef = loaded.attempt.candidateRef;
    const { preRound } = yield* makeIssue779PreRoundScenario({
      candidateIdentity: actualCandidateRef,
      purchasingContext: request.decision.purchasingContext,
    });
    const publication = yield* publishPricingLineValues({
      candidateRef: actualCandidateRef,
      decision: preRound.decision,
      preRound,
      publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE.profileVersion,
    });
    if (publication.outcome !== 'LINE_VALUES_PUBLISHED') {
      return yield* Effect.die('Expected real line publication');
    }
    const commercialTotal = yield* calculatePricingCommercialTotals({
      candidateRef: actualCandidateRef,
      decision: preRound.decision,
      preRound,
      publishedLines: publication.publishedLines,
    });
    if (commercialTotal.outcome !== 'COMMERCIAL_TOTAL_READY') {
      return yield* Effect.die('Expected real commercial total');
    }
    const currentDecision = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
      decision: commercialTotal.decision,
      subject: commercialTotal.decision.purchasingContext.subject,
    });
    expect(currentDecision).toEqual(request);
    const sourceRef = '44444444-4444-4444-8444-444444444444';
    const trusted = {
      actionInvocationId: '79700000-0000-4000-8000-000000000125',
      legalEntityId: commercialTotal.decision.commercialScope.sellingLegalEntityId,
      principalId: scope.principalId,
      tenantId: commercialTotal.decision.tenantId,
      trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(commercialTotal.decision.operationTime)),
    };
    const materialEvidence = makeQuotationMaterialEvidence(commercialTotal);
    const resolver = makeFreshCurrentResolver({
      compositionRevision: 'a'.repeat(64),
      evaluationFactory: {
        make: () => ({
          evaluate: () =>
            Effect.succeed({
              commercialTotal,
              kind: 'PRICE_RESOLVED' as const,
              materialEvidence,
              projection: {
                candidateRef: commercialTotal.candidateRef,
                currencyCode: commercialTotal.decision.currencyCode,
                lines: commercialTotal.publishedLines.map(({ occurrenceId, publishedLineValue }) => ({
                  occurrenceId,
                  publishedLineValue,
                })),
                monetaryBoundary: commercialTotal.decision.monetaryBoundary,
                pricingNetCommercialTotal: commercialTotal.pricingNetCommercialTotal,
              },
            }),
        }),
      },
      pricingOwnerFinalFence: {
        confirmObservedGenerationsThrough: () => Effect.die('Injected evaluator does not call final fence'),
        verifyOpaqueProofsAgainstCurrentState: () => Effect.die('Injected evaluator does not call final fence'),
      },
      scope: { ...scope, legalEntityId: trusted.legalEntityId },
      source: { loadFresh: () => Effect.die('Real attempt source already exercised above') },
      subjectAuthority: {
        verify: (input) =>
          Effect.succeed({
            evidence: evidenceFor(input.request, {
              actorPrincipalId:
                input.request.decision.purchasingContext.actor.kind === 'PRINCIPAL'
                  ? input.request.decision.purchasingContext.actor.principalId
                  : scope.principalId,
              kind: 'PROFILE',
              partyAuthorityRef: 'party:r1',
              partyAuthorityRevisionRef: 'party:r1:revision',
              subject: input.request.subject,
              subjectAuthorityRef: 'profile:r1',
              subjectAuthorityRevisionRef: 'profile:r1:revision',
            }),
            input,
            kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED' as const,
          }),
      },
    });
    const payload = yield* Schema.decodeEffect(ManageQuotationPayloadSchema)({
      candidateRef: actualCandidateRef,
      currentDecision,
      reason: 'Exact retained preproposal basis R1',
    });
    return { actualCandidateRef, currentDecision, payload, resolver, sourceRef, trusted };
  },
);

it.effect('carries the real preproposal candidate through registered issuance and basis completion verification', () =>
  Effect.gen(function* preproposalProducerBinding() {
    const scenario = yield* preproposalIssuanceScenario();
    const writes: string[] = [];
    const services = {
      lookupInvocation: () => Effect.succeedNone,
      resolveFresh: scenario.resolver,
    };
    const result = yield* applyQuotationManagement(scenario.payload, scenario.trusted, {
      ...services,
      store: ({ quotation }) => {
        writes.push(quotation.binding.candidateRef);
        return Effect.succeed(quotation);
      },
    });
    expect(result.quotation.binding.candidateRef).toBe(scenario.actualCandidateRef);
    expect(result.quotation.binding.candidateRef).not.toBe(scenario.sourceRef);
    expect(scenario.actualCandidateRef).toBe(currentPricingDecisionCandidateRef(scenario.currentDecision));
    expect(result.quotation.quotationRef).toBe(`pricing:quotation:${scenario.trusted.actionInvocationId}`);
    expect(pricingQuotationMatchesCurrentDecision(result.quotation, scenario.currentDecision)).toBe(true);
    assert(scenario.currentDecision.subject.kind === 'PROFILE');
    const selector = { sourceRef: scenario.sourceRef, sourceRevision: '1' };
    const retained = {
      legalEntityId: scenario.trusted.legalEntityId,
      pricingCandidateRef: scenario.actualCandidateRef,
      pricingInput: scenario.currentDecision,
      profileRef: scenario.currentDecision.subject.profileRef,
      retainedPricingInput: scenario.currentDecision,
      ...selector,
      tenantId: scenario.trusted.tenantId,
    };
    yield* verifyPreapprovalQuotationBinding(selector, retained, result.quotation, result.quotation.issuedAt);
    for (const changed of [
      { ...selector, sourceRef: scenario.actualCandidateRef },
      { ...selector, sourceRef: '55555555-5555-4555-8555-555555555555' },
      { ...selector, sourceRevision: '2' },
    ]) {
      const failure = yield* verifyPreapprovalQuotationBinding(
        changed,
        retained,
        result.quotation,
        result.quotation.issuedAt,
      ).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'read_handler_unavailable' });
    }
    for (const changed of [
      { ...retained, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { ...retained, legalEntityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { ...retained, pricingCandidateRef: scenario.sourceRef },
      { ...retained, profileRef: { ...retained.profileRef, resourceId: 'foreign-profile' } },
    ]) {
      const failure = yield* verifyPreapprovalQuotationBinding(
        selector,
        changed,
        result.quotation,
        result.quotation.issuedAt,
      ).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'read_handler_unavailable' });
    }

    const rejected = yield* applyQuotationManagement(
      { ...scenario.payload, candidateRef: scenario.sourceRef },
      scenario.trusted,
      { ...services, store: () => Effect.die('UUID candidate must fail before issuance/storage') },
    ).pipe(Effect.flip);
    expect(rejected).toMatchObject({ code: 'manage_quotation_current_authority_unavailable' });
    expect(writes).toEqual([scenario.actualCandidateRef]);
    for (const purchasingContext of [
      {
        ...scenario.currentDecision.decision.purchasingContext,
        contextRef: 'ccc:preproposal:55555555-5555-4555-8555-555555555555',
      },
      { ...scenario.currentDecision.decision.purchasingContext, contextRevision: 'foreign-revision' },
      {
        ...scenario.currentDecision.decision.purchasingContext,
        actor: { kind: 'PRINCIPAL' as const, principalId: 'foreign-buyer' },
      },
    ]) {
      expect(
        pricingQuotationMatchesCurrentDecision(result.quotation, {
          ...scenario.currentDecision,
          decision: { ...scenario.currentDecision.decision, purchasingContext },
        }),
      ).toBe(false);
    }
    expect(
      pricingQuotationMatchesCurrentDecision(result.quotation, {
        ...scenario.currentDecision,
        decision: { ...scenario.currentDecision.decision, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      }),
    ).toBe(false);
    // Identity and amount alone cannot prove the Cart/material input, even if the caller leaves total unchanged.
    expect(
      pricingQuotationMatchesCurrentDecision(result.quotation, {
        ...scenario.currentDecision,
        decision: {
          ...scenario.currentDecision.decision,
          lines: scenario.currentDecision.decision.lines.map((line) => ({
            ...line,
            catalog: { ...line.catalog, quantity: { ...line.catalog.quantity, resulting: '2' } },
          })),
        },
      }),
    ).toBe(false);
  }),
);

const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const counterpartySubject = {
  authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' as const },
  kind: 'PROFILE' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: 'profile:counterparty-discount-shortcut',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
    tenantId,
  },
};
const OWNER_AUDIENCE_REF = 'party.registry:counterparty-discount-audience';
const OWNER_DISCOUNT_REF = 'pricing-contractual-discount:current-set';

type DiscountReader = typeof CurrentPricingDecisionDiscountSetReader.Service;
type LoadCurrentInput = Parameters<DiscountReader['loadCurrent']>[0];
type Predicate = typeof PricingContractualDiscountSetPredicateSchema.Type;
type FakeReply =
  | { readonly kind: 'FAIL' }
  | { readonly kind: 'NO_ROWS' }
  | { readonly kind: 'ROWS'; readonly payload: object };

interface Harness {
  readonly invocations: () => number;
  readonly reader: DiscountReader;
}

/** Builds the production discount reader over the real persistence adapter and a scripted routine executor. */
const scriptedStorageFailure = () =>
  new EffectDrizzleQueryError({
    cause: Cause.fail(new SqlError({ reason: new UniqueViolation({ cause: {}, constraint: 'scripted' }) })),
    params: [],
    query: 'scripted owner failure',
  });

const withReader = <A, E, R>(replies: readonly FakeReply[], body: (harness: Harness) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* withScriptedReader() {
      let invocationCount = 0;
      // SAFETY: The reader reaches the routine invoker only; table operations and the private transaction marker are never observed.
      const scriptedTransaction = scopedRoutineInvokerFromTransaction(
        () => {
          const reply = replies[invocationCount];
          invocationCount += 1;
          if (reply === undefined || reply.kind === 'FAIL') {
            return Effect.fail(scriptedStorageFailure());
          }
          return Effect.succeed(reply.kind === 'NO_ROWS' ? [] : [{ payload: reply.payload }]);
        },
        { legalEntityId, tenantId },
      ) as unknown as ScopedTransactionExecutor;
      const adapters = yield* currentPricingDecisionWholeEvaluationAdaptersForScope(
        scriptedTransaction,
        scope,
        'a'.repeat(64),
      ).pipe(Effect.provideService(PricingExternalOwnerEvidenceValidation, externalOwnerEvidenceValidation));
      const context = yield* Layer.build(adapters);
      return yield* body({
        invocations: () => invocationCount,
        reader: Context.get(context, CurrentPricingDecisionDiscountSetReader),
      });
    }),
  );

const counterpartyRequest = Effect.fn('test.counterpartyRequest')(function* counterpartyRequestProgram() {
  const { compositionRequest } = yield* makeIssue779Scenario();
  const { decision } = compositionRequest;
  return yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
    decision: {
      ...decision,
      purchasingContext: {
        ...decision.purchasingContext,
        actor: { kind: 'PRINCIPAL', principalId: scope.principalId },
        subject: counterpartySubject,
      },
    },
    subject: counterpartySubject,
  });
});

const wholePurchasePredicate = (request: CurrentPricingDecisionRequest) =>
  Schema.decodeSync(PricingContractualDiscountSetPredicateSchema)({
    audiences: [{ counterpartyRef, kind: 'COUNTERPARTY' }],
    basis: { kind: 'WHOLE_PURCHASE' },
    commercialScope: request.decision.commercialScope,
    currencyCode: request.decision.currencyCode,
    effectiveAt: request.decision.operationTime,
    tenantId: request.decision.tenantId,
  });

const currentSetFor = (predicate: Predicate, discounts: readonly object[] = [], nextApplicabilityBoundary?: string) => {
  const predicateRef = pricingContractualDiscountSetPredicateRef(predicate);
  const ownerRevision = 'contractual-discount-set:generation:3';
  const observedAt = predicate.effectiveAt;
  const completenessEvidence = { observedAt, ownerRevision, scope: { kind: 'EXACT_PREDICATE', predicateRef } };
  if (nextApplicabilityBoundary !== undefined) {
    Object.assign(completenessEvidence, { nextApplicabilityBoundary });
  }
  return Schema.decodeUnknownSync(PricingContractualDiscountCurrentSetSchema)({
    authority: {
      generation: 3,
      observedAt,
      ownerRevision,
      ownerRootRef: `pricing:contractual-discount-set:${tenantId}`,
      predicateRef,
      verificationRef: `pricing:contractual-discount-set-proof:${predicateRef}`,
      verifiedAt: observedAt,
    },
    completenessEvidence,
    currentDiscounts: discounts,
    factProofs: discounts.map((discount) => ({
      factRef: Schema.decodeUnknownSync(ScheduledPricingDiscountRevisionSchema)(discount).definition.discountId,
      factRevisionRef: Schema.decodeUnknownSync(ScheduledPricingDiscountRevisionSchema)(discount).definition.revision
        .revisionId,
      verificationRef: 'pricing:contractual-discount-fact-proof:shortcut',
    })),
    predicate,
  });
};

const presentWholePurchaseDiscount = (predicate: Predicate) =>
  Schema.decodeUnknownSync(ScheduledPricingDiscountRevisionSchema)({
    definition: {
      discountId: '44444444-4444-4444-8444-444444444444',
      identityKey: {
        audience: { counterpartyRef, kind: 'COUNTERPARTY' },
        basis: { kind: 'WHOLE_PURCHASE' },
        commercialScope: predicate.commercialScope,
        currencyCode: predicate.currencyCode,
        effectKind: 'FIXED_MONETARY_AMOUNT',
        family: 'CONTRACTUAL_DISCOUNT',
        monetaryBoundary: 'PRE_TAX',
        scope: 'WHOLE_PURCHASE',
      },
      revision: {
        configuredEffect: {
          kind: 'FIXED_MONETARY_AMOUNT',
          level: { amount: '10', currencyCode: predicate.currencyCode },
        },
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        revision: 1,
        revisionId: '55555555-5555-4555-8555-555555555556',
      },
    },
    effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
    lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
  });

const counterpartyDiscountSnapshot = makeIssue787Snapshot();
const counterpartyDiscountAttempt = Schema.decodeUnknownSync(PricingEvaluationAttemptSchema)({
  attemptId: counterpartyDiscountSnapshot.attemptId,
  attemptOrdinal: 1,
  candidateRef: counterpartyDiscountSnapshot.candidateRef,
  completedAt: counterpartyDiscountSnapshot.capturedAt,
  maxAttempts: 2,
  runId: 'pricing-run:counterparty-discount-shortcut',
  snapshot: counterpartyDiscountSnapshot,
  startedAt: counterpartyDiscountSnapshot.requestedAt,
});

const inputFor = (request: CurrentPricingDecisionRequest, unitPrices: LoadCurrentInput['unitPrices']) => ({
  attempt: counterpartyDiscountAttempt,
  feeResults: [],
  request,
  unitPrices,
});

const expectFailure = (
  cause: CurrentPricingDecisionOwnerReadFailure,
  kind: 'UNAVAILABLE' | 'UNVERIFIABLE',
  ownerRef: string,
) => {
  expect(cause).toMatchObject({ kind, ownerRefs: [ownerRef] });
};

/** Completes after the fixture operation time so only the retained Discount boundary decides currentness. */
const counterpartyBoundaryAttempt = {
  ...counterpartyDiscountAttempt,
  completedAt: '2026-09-28T12:00:00.400Z',
} satisfies typeof counterpartyDiscountAttempt;

const GroupPricePathTagSchema = Schema.TaggedStruct('GROUP_PRICE', {});
const NoGroupNonePathTagSchema = Schema.TaggedStruct('NO_GROUP_NONE', {});

/** Re-expresses the assigned fixture lines as owner-NONE Price paths for the given Profile subject. */
const ownerNoneCommercialTotal = Effect.fn('test.ownerNoneCommercialTotal')(function* ownerNoneCommercialTotalProgram(
  profile: PriceGroupAssignmentProfile,
) {
  const commercialTotal = yield* assignedCommercialTotal();
  const { preRound } = commercialTotal.sourceEvidence;
  const lines = preRound.lines.map((line) => {
    const { unitPriceCalculation } = line.composition;
    const { exactPrice } = unitPriceCalculation.input;
    const { path } = exactPrice;
    assert(Schema.is(GroupPricePathTagSchema)(path));
    const ownerNonePath = {
      _tag: 'NO_GROUP_NONE' as const,
      discountAudience: { kind: 'NONE' as const },
      resolutionInput: {
        _tag: 'OWNER_NONE' as const,
        effectiveAt: path.resolutionInput.effectiveAt,
        interpretation: {
          _tag: 'NONE' as const,
          assignmentResolution: { _tag: 'NONE' as const },
          basis: path.resolutionInput.interpretation.basis,
          discountAudience: { kind: 'NONE' as const },
          priceSelector: { kind: 'NO_GROUP' as const },
        },
        ownerResolution: {
          effectiveAt: path.resolutionInput.effectiveAt,
          profile,
          resolution: { _tag: 'NONE' as const },
        },
      },
      usedPrice: path.usedPrice,
    };
    return {
      ...line,
      composition: {
        ...line.composition,
        unitPriceCalculation: {
          ...unitPriceCalculation,
          input: { ...unitPriceCalculation.input, exactPrice: { ...exactPrice, path: ownerNonePath } },
        },
      },
    };
  });
  return {
    ...commercialTotal,
    sourceEvidence: { ...commercialTotal.sourceEvidence, preRound: { ...preRound, lines } },
  };
});

const profileEvidenceFor = (request: CurrentPricingDecisionRequest) =>
  evidenceFor(request, {
    actorPrincipalId: scope.principalId,
    kind: 'PROFILE',
    partyAuthorityRef: 'party-authority:counterparty-discount',
    partyAuthorityRevisionRef: 'party-authority-revision:counterparty-discount',
    subject: request.subject,
    subjectAuthorityRef: 'profile-authority:counterparty-discount',
    subjectAuthorityRevisionRef: 'profile-authority-revision:counterparty-discount',
  });

describe('Counterparty Discount verified-empty evidence', () => {
  it.effect('retains the verified-empty whole-purchase set as Discount evidence', () =>
    Effect.gen(function* verifiedEmpty() {
      const request = yield* counterpartyRequest();
      const empty = currentSetFor(wholePurchasePredicate(request));
      const result = yield* withReader([{ kind: 'ROWS', payload: empty }], ({ invocations, reader }) =>
        reader.loadCurrent(inputFor(request, [])).pipe(Effect.map((read) => ({ calls: invocations(), read }))),
      );

      expect(result.read).toEqual({ applicabilityInputs: [], currentSets: [empty] });
      expect(result.calls).toBe(1);
    }),
  );

  it.effect('retains each exact line basis before the whole purchase in material-evidence order', () =>
    Effect.gen(function* verifiedEmptyPerBasis() {
      const request = yield* counterpartyRequest();
      const unitPrice = yield* calculatePricingUnitPrice(
        yield* unitPriceCalculationAttempt({ groupPath: false, quantity: '1' }),
      );
      const { path } = unitPrice.input.exactPrice;
      assert.isTrue('usedPrice' in path);
      if (!('usedPrice' in path)) {
        return;
      }
      const wholePredicate = wholePurchasePredicate(request);
      const linePredicate = yield* Schema.decodeEffect(PricingContractualDiscountSetPredicateSchema)({
        ...wholePredicate,
        basis: {
          catalogSelection: path.usedPrice.request.exactKey.catalogSelection,
          kind: 'VARIANT_LINE',
          unitBasis: path.usedPrice.request.exactKey.unitBasis,
        },
      });
      const lineSet = currentSetFor(linePredicate);
      const wholeSet = currentSetFor(wholePredicate);
      const result = yield* withReader(
        [
          { kind: 'ROWS', payload: lineSet },
          { kind: 'ROWS', payload: wholeSet },
        ],
        ({ invocations, reader }) =>
          reader
            .loadCurrent(inputFor(request, [unitPrice]))
            .pipe(Effect.map((read) => ({ calls: invocations(), read }))),
      );

      expect(result.read).toEqual({ applicabilityInputs: [], currentSets: [lineSet, wholeSet] });
      expect(result.read.currentSets.map(({ predicate }) => predicate.basis.kind)).toEqual([
        'VARIANT_LINE',
        'WHOLE_PURCHASE',
      ]);
      expect(result.calls).toBe(2);
    }),
  );

  it.effect('keeps the next applicability boundary of a verified-empty set', () =>
    Effect.gen(function* retainedBoundary() {
      const request = yield* counterpartyRequest();
      const boundary = '2026-09-28T13:00:00.000Z';
      const scheduled = currentSetFor(wholePurchasePredicate(request), [], boundary);
      const read = yield* withReader([{ kind: 'ROWS', payload: scheduled }], ({ reader }) =>
        reader.loadCurrent(inputFor(request, [])),
      );

      expect(
        read.currentSets.map(({ completenessEvidence }) => completenessEvidence.nextApplicabilityBoundary),
      ).toEqual([boundary]);
    }),
  );

  it.effect('selects the Counterparty Discount audience on an owner NONE Price path', () =>
    Effect.gen(function* counterpartyAudienceSelected() {
      const counterpartyTotal = yield* ownerNoneCommercialTotal({
        ...counterpartySubject.profileRef,
        kind: 'COUNTERPARTY',
      });
      expect(
        counterpartyTotal.sourceEvidence.preRound.lines.every(({ composition }) =>
          Schema.is(NoGroupNonePathTagSchema)(composition.unitPriceCalculation.input.exactPrice.path),
        ),
      ).toBe(true);
      const counterparty = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
        decision: decisionForSubject(counterpartyTotal.decision, counterpartySubject),
        subject: counterpartySubject,
      });
      const retailTotal = yield* ownerNoneCommercialTotal({ ...profileSubject.profileRef, kind: 'RETAIL' });
      const retail = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
        decision: decisionForSubject(retailTotal.decision, profileSubject),
        subject: profileSubject,
      });

      const counterpartySelection = yield* buildCurrentPricingDiscountNonSelection({
        commercialTotal: counterpartyTotal,
        request: counterparty,
        subjectEvidence: profileEvidenceFor(counterparty),
      });
      const retailSelection = yield* buildCurrentPricingDiscountNonSelection({
        commercialTotal: retailTotal,
        request: retail,
        subjectEvidence: profileEvidenceFor(retail),
      });

      expect(counterpartySelection).toEqual({ kind: 'DISCOUNT_AUDIENCE_SELECTED' });
      expect(retailSelection).toMatchObject({
        kind: 'DISCOUNT_NOT_SELECTED',
        selection: { audienceDecision: { kind: 'PROFILE_OWNER_NONE' } },
      });
    }),
  );

  it.effect('publishes a verified-empty set as VERIFIED_ABSENT bounded by its next boundary', () =>
    Effect.gen(function* boundaryNotCrossed() {
      const request = yield* counterpartyRequest();
      const boundary = '2026-09-28T13:00:00.000Z';
      const scheduled = currentSetFor(wholePurchasePredicate(request), [], boundary);

      const evidence = yield* buildCurrentPricingDiscountSourceEvidence({
        attempt: counterpartyBoundaryAttempt,
        currentSet: scheduled,
        request,
      });

      assert(Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(evidence));
      expect(evidence.completeness.family).toBe('DISCOUNT');
      expect(evidence.completeness.temporal.nextMaterialBoundary).toBe(boundary);
      expect(evidence.completeness.completenessEvidence.nextApplicabilityBoundary).toBe(boundary);
      expect(evidence.completeness.ownerScope.predicateRef).toBe(scheduled.authority.predicateRef);
      expect(evidence.completeness.verification.verificationRef).toBe(scheduled.authority.verificationRef);
    }),
  );

  it.effect('fails STALE when the whole attempt completes at the next applicability boundary', () =>
    Effect.gen(function* boundaryCrossed() {
      const request = yield* counterpartyRequest();
      const scheduled = currentSetFor(wholePurchasePredicate(request), [], counterpartyBoundaryAttempt.completedAt);

      const failure = yield* buildCurrentPricingDiscountSourceEvidence({
        attempt: counterpartyBoundaryAttempt,
        currentSet: scheduled,
        request,
      }).pipe(Effect.flip);

      expect(Schema.is(CurrentPricingDecisionOwnerReadFailure)(failure)).toBe(true);
      expect(failure).toMatchObject({ kind: 'STALE', ownerRefs: [scheduled.authority.ownerRootRef] });
    }),
  );

  it.effect('fails closed when a Discount exists for the Counterparty audience', () =>
    Effect.gen(function* presentDiscount() {
      const request = yield* counterpartyRequest();
      const predicate = wholePurchasePredicate(request);
      const present = currentSetFor(predicate, [presentWholePurchaseDiscount(predicate)]);
      expect(present.currentDiscounts).toHaveLength(1);

      const failure = yield* withReader([{ kind: 'ROWS', payload: present }], ({ reader }) =>
        reader.loadCurrent(inputFor(request, [])).pipe(Effect.flip),
      );

      expectFailure(failure, 'UNVERIFIABLE', OWNER_AUDIENCE_REF);
    }),
  );

  it.effect('fails closed without any lookup when a Price Group audience is assigned', () =>
    Effect.gen(function* assignedAudience() {
      const request = yield* counterpartyRequest();
      const { compositionRequest } = yield* makeIssue779Scenario();
      const [assignedUnitPrice] = compositionRequest.unitPrices;
      assert.isDefined(assignedUnitPrice);
      if (assignedUnitPrice === undefined) {
        return;
      }
      const outcome = yield* withReader([], ({ invocations, reader }) =>
        reader.loadCurrent(inputFor(request, [assignedUnitPrice])).pipe(
          Effect.flip,
          Effect.map((failure) => ({ calls: invocations(), failure })),
        ),
      );

      expectFailure(outcome.failure, 'UNVERIFIABLE', OWNER_AUDIENCE_REF);
      expect(outcome.calls).toBe(0);
    }),
  );

  it.effect('fails closed when the owner returns no verification for the Current set', () =>
    Effect.gen(function* verificationAbsent() {
      const request = yield* counterpartyRequest();
      const failure = yield* withReader([{ kind: 'NO_ROWS' }], ({ reader }) =>
        reader.loadCurrent(inputFor(request, [])).pipe(Effect.flip),
      );

      expectFailure(failure, 'UNAVAILABLE', OWNER_DISCOUNT_REF);
    }),
  );

  it.effect('fails closed when the owner proof binds a different predicate than the one requested', () =>
    Effect.gen(function* driftedPredicate() {
      const request = yield* counterpartyRequest();
      const drifted = yield* Schema.decodeEffect(PricingContractualDiscountSetPredicateSchema)({
        ...wholePurchasePredicate(request),
        currencyCode: request.decision.currencyCode === 'CZK' ? 'EUR' : 'CZK',
      });
      const failure = yield* withReader([{ kind: 'ROWS', payload: currentSetFor(drifted) }], ({ reader }) =>
        reader.loadCurrent(inputFor(request, [])).pipe(Effect.flip),
      );

      expectFailure(failure, 'UNAVAILABLE', OWNER_DISCOUNT_REF);
    }),
  );

  it.effect('fails closed when the owner read itself is unavailable', () =>
    Effect.gen(function* ownerUnavailable() {
      const request = yield* counterpartyRequest();
      const failure = yield* withReader([{ kind: 'FAIL' }], ({ reader }) =>
        reader.loadCurrent(inputFor(request, [])).pipe(Effect.flip),
      );

      expectFailure(failure, 'UNAVAILABLE', OWNER_DISCOUNT_REF);
    }),
  );
});
