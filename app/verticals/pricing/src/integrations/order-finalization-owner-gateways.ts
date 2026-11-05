import type { CoreSearchResourceRefSchema, OperationalScope } from '@app/core-runtime';
import { readVerifiedGatewayActor } from '@app/core-runtime';
import {
  FinalCartCandidateRefSchema,
  FinalCartCandidateRequestSchema,
} from '@app/commerce-cart-finalization-contracts/final-candidate';
import { executeFinalCartCandidateWithAuthorization } from '@app/commerce-cart-finalization-contracts/final-candidate/client';
import { executePreparedOrderPricingBindingWithAuthorization } from '@app/commerce-order-contracts/prepared-order-pricing-binding/client';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { PricingCommitmentConfirmationBindingSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingCommitmentConfirmationBinding } from '@app/pricing-contracts/domain/commitment-confirmation';
import { Crypto, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import type { CurrentPricingDecisionCustomerContextGatewayIssuerService } from '../services/current-pricing-decision-subject-authority.service.ts';
import {
  CurrentPricingDecisionCustomerContextGatewayIssuer,
  CurrentPricingDecisionCustomerContextGatewayUnavailable,
} from '../services/current-pricing-decision-subject-authority.service.ts';
import { acquireOwnerGatewayConnection } from './owner-gateway-connection.ts';

export class PricingFinalizationAuthorityUnavailable extends Schema.TaggedError<PricingFinalizationAuthorityUnavailable>()(
  'PricingFinalizationAuthorityUnavailable',
  { reason: Schema.String },
) {}

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new PricingFinalizationAuthorityUnavailable({
      reason: 'The exact final Cart and prepared Order authority is unavailable',
    }),
    'cause',
    { value: cause },
  );

export const isOrderFinalizationPricingContext = (contextRef: string): boolean =>
  /^ccc:order-finalization:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(contextRef);

/** The finalized buyer is the subject the owner read acts for; any other buyer is another customer's evidence. */
export const finalizationBuyerMatchesSubject = (buyerPrincipalId: string, subjectPrincipalId: string): boolean =>
  buyerPrincipalId === subjectPrincipalId;

/** Only the Order module, acting for its buyer, may read finalization evidence (DESIGN D8). */
export const finalizationCallerMatches = (actor?: { readonly appId: string }): boolean =>
  actor?.appId === 'commerce-order';

const sameBinding = Schema.toEquivalence(PricingCommitmentConfirmationBindingSchema);
const sameRequest = Schema.toEquivalence(CurrentPricingDecisionRequestSchema);

/**
 * Owner evidence for finalization, acting for the subject of `scope`. The subject is the buyer: every
 * candidate and binding read here must name `scope.principalId` as its buyer, so a caller can only obtain
 * evidence for its own buyer's final candidate. The calling module is carried by the verified actor.
 */
export const pricingFinalizationOwnerGateways = Effect.fn('PricingFinalization.ownerGateways')(function* ownerGateways(
  scope: OperationalScope,
  compositionRevision: string,
  crypto: Crypto.Crypto,
) {
  if (!finalizationCallerMatches(readVerifiedGatewayActor(scope))) {
    return yield* unavailable('The caller is not the Order module acting for its buyer');
  }
  if (scope.legalEntityId === undefined) {
    return yield* unavailable('A Selling Legal Entity is required for the owner gateway');
  }
  const credentialFor = Effect.fn('PricingFinalization.ownerCredential')(function* ownerCredential(
    audience: 'commerce-cart' | 'commerce-order' | 'commerce-customer-context',
  ) {
    const issued = yield* acquireOwnerGatewayConnection(
      {
        audience,
        compositionRevision,
        legalEntityScope: 'subject',
        requestCorrelation: scope.correlationId,
        scope,
      },
      crypto,
    ).pipe(Effect.mapError(unavailable));
    return { baseUrl: issued.baseUrl, credential: Redacted.value(issued.credential) };
  });
  const readCandidate = Effect.fn('PricingFinalization.readFinalCartCandidate')(function* readCandidate(
    candidateRef: typeof CoreSearchResourceRefSchema.Encoded,
    candidateHash: string,
  ) {
    const request = yield* Schema.decodeUnknownEffect(FinalCartCandidateRequestSchema)({
      candidateHash,
      candidateRef,
    }).pipe(Effect.mapError(unavailable));
    if (!('candidateRef' in request)) {
      return yield* unavailable('Exact final Cart candidate consumption is required');
    }
    const owner = yield* credentialFor('commerce-cart');
    const candidate = yield* executeFinalCartCandidateWithAuthorization(
      request,
      owner.credential,
      scope.correlationId,
      { baseUrl: owner.baseUrl, compositionRevision },
    ).pipe(Effect.mapError(unavailable));
    if (
      candidate.candidateHash !== candidateHash ||
      candidate.candidateRef.resourceId !== request.candidateRef.resourceId ||
      candidate.tenantId !== scope.tenantId ||
      candidate.legalEntityId !== scope.legalEntityId ||
      !finalizationBuyerMatchesSubject(candidate.buyerPrincipalId, scope.principalId)
    ) {
      return yield* unavailable('Cart returned a different immutable final candidate for this buyer');
    }
    return candidate;
  });
  const verifyBinding = Effect.fn('PricingFinalization.verifyPermanentBinding')(function* verifyBinding(
    binding: PricingCommitmentConfirmationBinding,
  ) {
    const owner = yield* credentialFor('commerce-order');
    const prepared = yield* executePreparedOrderPricingBindingWithAuthorization(
      binding,
      owner.credential,
      scope.correlationId,
      { baseUrl: owner.baseUrl, compositionRevision },
    ).pipe(Effect.mapError(unavailable));
    const now = yield* DateTime.now;
    if (
      !sameBinding(prepared.binding, binding) ||
      prepared.tenantId !== scope.tenantId ||
      prepared.legalEntityId !== scope.legalEntityId ||
      !finalizationBuyerMatchesSubject(prepared.buyerPrincipalId, scope.principalId) ||
      DateTime.isGreaterThan(prepared.observedAt, now) ||
      !DateTime.isGreaterThan(prepared.validUntil, now)
    ) {
      return yield* unavailable('The retained permanent Attempt and Bundle no longer match');
    }
    const candidate = yield* readCandidate(prepared.cartCandidateRef, prepared.cartCandidateHash);
    if (
      candidate.buyerPrincipalId !== prepared.buyerPrincipalId ||
      candidate.candidateRef.resourceId !== binding.purchase.candidateRef ||
      candidate.pricing.decision.purchasingContext.contextRef !== binding.purchase.subject.purchaseContext.contextRef ||
      candidate.pricing.decision.purchasingContext.contextRevision !==
        binding.purchase.subject.purchaseContext.contextRevision
    ) {
      return yield* unavailable('Order and Cart disagree about the final buyer or purchase context');
    }
    return candidate;
  });
  return { credentialFor, readCandidate, verifyBinding };
});

/** Customer Context owner credential: Pricing acts for the verified subject through the module credential. */
export const pricingFinalizationCustomerContextGatewayIssuerLive = Layer.effect(
  CurrentPricingDecisionCustomerContextGatewayIssuer,
  Effect.gen(function* pricingFinalizationCustomerContextGatewayIssuer() {
    const crypto = yield* Crypto.Crypto;
    return {
      issue: Effect.fn('PricingFinalizationCustomerContext.issue')(function* issueCustomerContextCredential(
        input: Parameters<CurrentPricingDecisionCustomerContextGatewayIssuerService['issue']>[0],
      ) {
        if (input.principal.legalEntityId === undefined) {
          return yield* new CurrentPricingDecisionCustomerContextGatewayUnavailable({
            reason: 'GATEWAY_ISSUER_UNAVAILABLE',
          });
        }
        const connection = yield* acquireOwnerGatewayConnection(
          {
            audience: 'commerce-customer-context',
            compositionRevision: input.compositionRevision,
            legalEntityScope: 'subject',
            requestCorrelation: input.requestCorrelation,
            scope: input.principal,
          },
          crypto,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CurrentPricingDecisionCustomerContextGatewayUnavailable({
                cause,
                reason: 'GATEWAY_ISSUER_UNAVAILABLE',
              }),
          ),
        );
        return connection;
      }),
    };
  }),
);

export const verifyFinalCartQuotationRequest = Effect.fn('PricingFinalization.verifyQuotationRequest')(
  function* verifyQuotationRequest(
    input: {
      readonly candidateHash?: string;
      readonly candidateRef: string;
      readonly currentDecision: typeof CurrentPricingDecisionRequestSchema.Type;
    },
    scope: OperationalScope,
    compositionRevision: string,
    crypto: Crypto.Crypto,
  ) {
    if (input.candidateHash === undefined) {
      return yield* unavailable('Final Cart candidate hash is required');
    }
    const owners = yield* pricingFinalizationOwnerGateways(scope, compositionRevision, crypto);
    const candidateRef = yield* Schema.decodeUnknownEffect(FinalCartCandidateRefSchema)({
      moduleId: 'commerce.cart',
      resourceId: input.candidateRef,
      resourceType: 'commerce.cart.final-cart-candidate',
      tenantId: scope.tenantId,
    }).pipe(Effect.mapError(unavailable));
    const candidate = yield* owners.readCandidate(candidateRef, input.candidateHash);
    if (!sameRequest(candidate.pricing, input.currentDecision)) {
      return yield* unavailable('Quotation input differs from the immutable final Cart handoff');
    }
    return candidate;
  },
);
