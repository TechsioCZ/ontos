import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { PricingPurchaseContextVerificationResponseSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import type { PricingPurchaseContextVerificationRequest } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import type { PricingMaterialEvidenceFenceSource } from '@app/pricing-contracts/domain/material-evidence';
import { Effect, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makePricingCurrentDecisionCustomerContextOwnerFinalFenceGateway } from '../../src/integrations/current-pricing-decision-owner-final-fence.ts';
import type { PricingOwnerMaterialEvidenceFenceGatewayUnavailable } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import { OwnerGatewayConnectionError } from '../../src/integrations/owner-gateway-connection.ts';
import type { OwnerGatewayConnectionInput } from '../../src/integrations/owner-gateway-connection.ts';
import { verifiedTestScope } from '../support/owner-gateway-connection.fixture.ts';
import { makeIssue787Snapshot } from './support/issue-787-material-change.fixture.ts';

const candidateRef = 'candidate:purchase-replay';
const compositionRevision = 'revision:purchase-replay';
const ownerConnectionSecret = 'owner-connection-credential-secret';
const baseUrl = new URL('https://customer-context.internal.example/');
const customerPrincipalId = Schema.decodeSync(PrincipalIdSchema)('77777777-7777-4777-8777-777777777777');

const snapshot = makeIssue787Snapshot();
const retainedEvidence = {
  currentness: {
    evaluatedAt: snapshot.decision.operationTime,
    observedAt: snapshot.decision.operationTime,
    validFrom: snapshot.decision.operationTime,
    validTo: null,
  },
  ownerRef: snapshot.decision.purchasingContext.contextRef,
  ownerRevisionRef: snapshot.decision.purchasingContext.contextRevision,
  subjectAuthority: {
    actorPrincipalId: customerPrincipalId,
    kind: 'PROFILE' as const,
    partyAuthorityRef: 'party-authority:replay',
    partyAuthorityRevisionRef: 'party-authority-revision:replay',
    subject: snapshot.decision.purchasingContext.subject,
    subjectAuthorityRef: 'subject-authority:replay',
    subjectAuthorityRevisionRef: 'subject-authority-revision:replay',
  },
  verificationRef: 'purchase-context-verification:replay',
  verifiedScope: {
    channelId: snapshot.decision.commercialScope.channelId,
    legalEntityId: snapshot.decision.commercialScope.sellingLegalEntityId,
    marketId: snapshot.decision.commercialScope.marketId,
    tenantId: snapshot.decision.tenantId,
  },
};
const purchaseRequest = {
  actor: { kind: 'AUTHENTICATED_CUSTOMER' as const, principalId: customerPrincipalId },
  operationTime: snapshot.decision.operationTime,
  purchasingContext: {
    channelId: snapshot.decision.commercialScope.channelId,
    contextRef: snapshot.decision.purchasingContext.contextRef,
    contextRevision: snapshot.decision.purchasingContext.contextRevision,
    marketId: snapshot.decision.commercialScope.marketId,
    sellingLegalEntityId: snapshot.decision.commercialScope.sellingLegalEntityId,
  },
  subject: snapshot.decision.purchasingContext.subject,
  tenantId: snapshot.decision.tenantId,
};
const purchaseSource: PricingMaterialEvidenceFenceSource = {
  verificationMaterial: {
    evidence: retainedEvidence,
    kind: 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY',
    request: purchaseRequest,
  },
};

const verifiedResponse = (evidence: typeof retainedEvidence) =>
  Schema.decodeUnknownSync(PricingPurchaseContextVerificationResponseSchema)({
    evidence,
    outcome: 'PURCHASE_CONTEXT_VERIFIED',
    request: purchaseRequest,
  });

interface ExecutorCall {
  readonly correlation: string;
  readonly credential: string;
  readonly payload: PricingPurchaseContextVerificationRequest;
}

/** Builds the real Customer Context fence gateway over a recording owner connection and Purchase Context executor. */
type PurchaseContextReply = ReturnType<
  NonNullable<
    Parameters<typeof makePricingCurrentDecisionCustomerContextOwnerFinalFenceGateway>[0]['executePurchaseContext']
  >
>;

const subjectScope = verifiedTestScope({
  correlationId: candidateRef,
  legalEntityId: purchaseRequest.purchasingContext.sellingLegalEntityId,
  principalId: customerPrincipalId,
  tenantId: snapshot.decision.tenantId,
});

const makeGateway = (reply: () => PurchaseContextReply, acquireFails = false) => {
  const executorCalls: ExecutorCall[] = [];
  const acquireCalls: OwnerGatewayConnectionInput[] = [];
  const gateway = makePricingCurrentDecisionCustomerContextOwnerFinalFenceGateway({
    acquire: (input) => {
      acquireCalls.push(input);
      return acquireFails
        ? Effect.fail(new OwnerGatewayConnectionError({ reason: 'Owner gateway is unavailable' }))
        : Effect.succeed({ baseUrl, credential: Redacted.make(ownerConnectionSecret) });
    },
    execute: () => Effect.die('Price Group replay must not run for a source-free Purchase Context singleton'),
    executePurchaseContext: (payload, credential, correlation) => {
      executorCalls.push({ correlation, credential: Redacted.value(credential), payload });
      return reply();
    },
  });
  return { acquireCalls, executorCalls, gateway };
};

const verificationContext = {
  candidateRef,
  decision: snapshot.decision,
  effectiveAt: snapshot.decision.operationTime,
  evaluatedAt: snapshot.capturedAt,
  requestedAt: snapshot.requestedAt,
};

const replay = (gateway: ReturnType<typeof makeGateway>['gateway']) =>
  gateway.verifyOpaqueProofsAgainstCurrentState({
    candidateRef,
    compositionRevision,
    scope: subjectScope,
    sources: [],
    typedSources: [purchaseSource],
    verificationContext,
  });

const expectFailsClosed = (failure: PricingOwnerMaterialEvidenceFenceGatewayUnavailable, reason: RegExp) => {
  expect(failure).toMatchObject({ ownerModuleId: 'commerce.customer-context', retryable: true });
  expect(failure.reason).toMatch(reason);
};

describe('Pricing final fence Purchase Context replay for the verified subject', () => {
  it.effect('replays for the verified subject through the owner connection, not the caller assertion', () =>
    Effect.gen(function* serviceIdentityReplay() {
      const { acquireCalls, executorCalls, gateway } = makeGateway(() =>
        Effect.succeed(verifiedResponse(retainedEvidence)),
      );

      const result = yield* replay(gateway);

      expect(result.observations).toEqual([]);
      expect(acquireCalls).toEqual([
        {
          audience: 'commerce-customer-context',
          compositionRevision,
          legalEntityScope: 'subject',
          requestCorrelation: candidateRef,
          scope: subjectScope,
        },
      ]);
      expect(executorCalls).toHaveLength(1);
      const [call] = executorCalls;
      expect(call?.credential).toBe(ownerConnectionSecret);
      expect(call?.correlation).toBe(candidateRef);
      // The retained buyer actor travels as data; the buyer's own gateway assertion is never retained or forwarded.
      expect(call?.payload).toEqual(purchaseRequest);
    }),
  );

  it.effect('replays once per final-fence phase, including generation confirmation', () =>
    Effect.gen(function* bothPhases() {
      const { executorCalls, gateway } = makeGateway(() => Effect.succeed(verifiedResponse(retainedEvidence)));

      yield* gateway.confirmObservedGenerationsThrough({
        candidateRef,
        compositionRevision,
        observations: [],
        scope: subjectScope,
        through: snapshot.decision.operationTime,
        typedSources: [purchaseSource],
      });

      expect(executorCalls.map(({ credential }) => credential)).toEqual([ownerConnectionSecret]);
    }),
  );

  it.effect('fails the fence when the verified verification reference no longer matches the retained evidence', () =>
    Effect.gen(function* changedVerification() {
      const { gateway } = makeGateway(() =>
        Effect.succeed(
          verifiedResponse({ ...retainedEvidence, verificationRef: 'purchase-context-verification:other' }),
        ),
      );

      expectFailsClosed(yield* replay(gateway).pipe(Effect.flip), /owner revision changed/iu);
    }),
  );

  it.effect('fails the fence when the verified subject authority differs from the retained evidence', () =>
    Effect.gen(function* changedSubjectAuthority() {
      const { gateway } = makeGateway(() =>
        Effect.succeed(
          verifiedResponse({
            ...retainedEvidence,
            subjectAuthority: {
              ...retainedEvidence.subjectAuthority,
              partyAuthorityRevisionRef: 'party-authority-revision:changed',
            },
          }),
        ),
      );

      expectFailsClosed(yield* replay(gateway).pipe(Effect.flip), /owner revision changed/iu);
    }),
  );

  it.effect('fails the fence when the owner no longer verifies the Purchase Context', () =>
    Effect.gen(function* notVerified() {
      const { gateway } = makeGateway(() =>
        Effect.succeed(
          Schema.decodeUnknownSync(PricingPurchaseContextVerificationResponseSchema)({
            outcome: 'PURCHASE_CONTEXT_MISMATCH',
            reason: 'SUBJECT_MISMATCH',
            request: purchaseRequest,
          }),
        ),
      );

      expectFailsClosed(yield* replay(gateway).pipe(Effect.flip), /no longer verified/iu);
    }),
  );

  it.effect('fails closed when the owner replay is unavailable', () =>
    Effect.gen(function* ownerUnavailable() {
      // A genuine client-side Schema failure stands in for any typed client failure; all are mapped identically.
      const { gateway } = makeGateway(() => Schema.decodeUnknownEffect(Schema.Finite)('owner down'));

      expectFailsClosed(yield* replay(gateway).pipe(Effect.flip), /owner replay is unavailable/iu);
    }),
  );

  it.effect('fails closed on an unverifiable owner response body', () =>
    Effect.gen(function* garbageResponse() {
      const { gateway } = makeGateway(() => Effect.succeed({ outcome: 'PURCHASE_CONTEXT_VERIFIED' }));

      expectFailsClosed(yield* replay(gateway).pipe(Effect.flip), /response is unverifiable/iu);
    }),
  );

  it.effect('fails closed without calling the owner when the Pricing service credential is unavailable', () =>
    Effect.gen(function* credentialUnavailable() {
      const { executorCalls, gateway } = makeGateway(() => Effect.succeed(verifiedResponse(retainedEvidence)), true);

      expectFailsClosed(yield* replay(gateway).pipe(Effect.flip), /credential is unavailable/iu);
      expect(executorCalls).toHaveLength(0);
    }),
  );

  it.effect('fails closed without calling the owner when the Purchase Context singleton is absent', () =>
    Effect.gen(function* singletonAbsent() {
      const { executorCalls, gateway } = makeGateway(() => Effect.succeed(verifiedResponse(retainedEvidence)));

      const failure = yield* gateway
        .verifyOpaqueProofsAgainstCurrentState({
          candidateRef,
          compositionRevision,
          scope: subjectScope,
          sources: [],
          typedSources: [],
          verificationContext,
        })
        .pipe(Effect.flip);

      expectFailsClosed(failure, /singleton authority is required/iu);
      expect(executorCalls).toHaveLength(0);
    }),
  );
});
