import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  CurrentPricingDecisionExternalOwnerEvidenceDependencies,
  CurrentPricingDecisionExternalOwnerEvidenceReadContext,
} from '../../src/integrations/current-pricing-decision-external-owner-evidence.ts';
import { makeCurrentPricingDecisionExternalOwnerEvidencePort } from '../../src/integrations/current-pricing-decision-external-owner-evidence.ts';
import { CurrentPricingDecisionOwnerReadFailure } from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import { makePricingExternalOwnerEvidenceValidationService } from '../../src/services/external-owner-evidence-validation.service.ts';
import {
  makeIssue788Attempt,
  makeIssue788CommercialTotal,
  makeIssue788MaterialEvidence,
} from './support/issue-788-confirmation.fixture.ts';

const inputFixture = Effect.fn('test.currentPricingDecisionExternalOwnerEvidence.inputFixture')(
  function* inputFixtureProgram() {
    const rawCommercialTotal = yield* makeIssue788CommercialTotal();
    const subject = {
      guestEvidenceRef: 'guest-evidence:external-owner-790',
      guestSessionRef: 'guest-session:external-owner-790',
      kind: 'GUEST' as const,
    };
    const commercialTotal = {
      ...rawCommercialTotal,
      decision: {
        ...rawCommercialTotal.decision,
        purchasingContext: {
          ...rawCommercialTotal.decision.purchasingContext,
          actor: subject,
          subject,
        },
      },
    };
    const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
      decision: commercialTotal.decision,
      subject,
    });
    const materialEvidence = makeIssue788MaterialEvidence(commercialTotal);
    const attempt = makeIssue788Attempt(commercialTotal, materialEvidence);
    const purchaseContextEvidence = yield* Schema.decodeEffect(PricingPurchaseContextVerificationEvidenceSchema)({
      currentness: {
        evaluatedAt: commercialTotal.decision.operationTime,
        observedAt: commercialTotal.decision.operationTime,
        validFrom: commercialTotal.decision.operationTime,
        validTo: null,
      },
      ownerRef: commercialTotal.decision.purchasingContext.contextRef,
      ownerRevisionRef: commercialTotal.decision.purchasingContext.contextRevision,
      subjectAuthority: {
        guestEvidenceAuthorityRef: 'guest-evidence-authority:external-owner-790',
        guestSessionAuthorityRef: 'guest-session-authority:external-owner-790',
        kind: 'GUEST',
        subject,
        subjectAuthorityRevisionRef: 'guest-authority-revision:external-owner-790',
      },
      verificationRef: 'purchase-context-verification:external-owner-790',
      verifiedScope: {
        channelId: commercialTotal.decision.commercialScope.channelId,
        legalEntityId: commercialTotal.decision.commercialScope.sellingLegalEntityId,
        marketId: commercialTotal.decision.commercialScope.marketId,
        tenantId: commercialTotal.decision.tenantId,
      },
    });
    return { attempt, commercialTotal, purchaseContextEvidence, request };
  },
);

const allFailingDependencies = (
  failure: CurrentPricingDecisionOwnerReadFailure,
  observedContexts: CurrentPricingDecisionExternalOwnerEvidenceReadContext[],
): CurrentPricingDecisionExternalOwnerEvidenceDependencies => {
  const fail = (context: CurrentPricingDecisionExternalOwnerEvidenceReadContext) => {
    observedContexts.push(context);
    return Effect.fail(failure);
  };
  return {
    catalog: { loadFresh: fail },
    customerContext: { loadFresh: fail },
    market: { loadFresh: fail },
    promotion: { loadFresh: fail },
    validation: makePricingExternalOwnerEvidenceValidationService(),
  };
};

describe('Current Pricing Decision external-owner evidence aggregation #790', () => {
  it.effect('starts every owner read from one exact time-bound context and preserves owner unavailability', () =>
    Effect.gen(function* preservesOwnerFailure() {
      const input = yield* inputFixture();
      const ownerFailure = new CurrentPricingDecisionOwnerReadFailure({
        kind: 'UNAVAILABLE',
        ownerRefs: ['commerce.market-catalog'],
        reason: 'Market owner is unavailable',
      });
      const observedContexts: CurrentPricingDecisionExternalOwnerEvidenceReadContext[] = [];
      const port = makeCurrentPricingDecisionExternalOwnerEvidencePort(
        allFailingDependencies(ownerFailure, observedContexts),
      );

      const failure = yield* port.loadFresh(input).pipe(Effect.flip);

      expect(failure).toBe(ownerFailure);
      expect(failure.kind).toBe('UNAVAILABLE');
      expect(observedContexts).toHaveLength(4);
      expect(
        observedContexts.every(
          (context) =>
            context.effectiveAt === input.request.decision.operationTime &&
            context.requestedAt === input.attempt.snapshot.requestedAt &&
            context.request === input.request &&
            context.purchaseContextEvidence === input.purchaseContextEvidence,
        ),
      ).toBe(true);
    }),
  );

  it.effect('rejects a mixed candidate before invoking any external owner', () =>
    Effect.gen(function* rejectsMixedCandidate() {
      const input = yield* inputFixture();
      let readCount = 0;
      const neverRead = () => {
        readCount += 1;
        return Effect.die('Mixed candidate must fail before external owner reads');
      };
      const port = makeCurrentPricingDecisionExternalOwnerEvidencePort({
        catalog: { loadFresh: neverRead },
        customerContext: { loadFresh: neverRead },
        market: { loadFresh: neverRead },
        promotion: { loadFresh: neverRead },
        validation: makePricingExternalOwnerEvidenceValidationService(),
      });

      const failure = yield* port
        .loadFresh({ ...input, commercialTotal: { ...input.commercialTotal, candidateRef: 'candidate:mixed-790' } })
        .pipe(Effect.flip);

      expect(failure.kind).toBe('UNVERIFIABLE');
      expect(failure.reason).toContain('exact coherent Pricing attempt');
      expect(readCount).toBe(0);
    }),
  );
});
