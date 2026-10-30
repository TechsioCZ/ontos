import type { CoreSearchResourceRefSchema, OperationalScope } from '@app/core-runtime';
import {
  FinalCartCandidateRefSchema,
  FinalCartCandidateRequestSchema,
} from '@app/commerce-cart-finalization-contracts/final-candidate';
import { executeFinalCartCandidateWithAuthorization } from '@app/commerce-cart-finalization-contracts/final-candidate/client';
import { executePreparedOrderPricingBindingWithAuthorization } from '@app/commerce-order-contracts/prepared-order-pricing-binding/client';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { PricingCommitmentConfirmationBindingSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingCommitmentConfirmationBinding } from '@app/pricing-contracts/domain/commitment-confirmation';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import type { CurrentPricingDecisionCustomerContextGatewayIssuerService } from '../services/current-pricing-decision-subject-authority.service.ts';
import {
  CurrentPricingDecisionCustomerContextGatewayIssuer,
  CurrentPricingDecisionCustomerContextGatewayUnavailable,
} from '../services/current-pricing-decision-subject-authority.service.ts';

const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Owner gateway URL must be an HTTP(S) origin without credentials, query or fragment',
  ),
);
const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_PRICING_GATEWAY_API_KEY'),
  orderNamespaceId: Config.schema(Schema.String, 'ONTOS_PRICING_ORDER_NAMESPACE_ID'),
  orderPrincipalId: Config.schema(Schema.String.check(Schema.isUUID()), 'ONTOS_PRICING_ORDER_PRINCIPAL_ID'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

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

const sameBinding = Schema.toEquivalence(PricingCommitmentConfirmationBindingSchema);
const sameRequest = Schema.toEquivalence(CurrentPricingDecisionRequestSchema);

/** This bridge authenticates Pricing as Pricing; the buyer remains retained owner evidence. */
export const pricingFinalizationOwnerGateways = Effect.fn('PricingFinalization.ownerGateways')(function* ownerGateways(
  scope: OperationalScope,
  compositionRevision: string,
) {
  const configured = yield* configuration.pipe(Effect.mapError(unavailable));
  if (
    scope.authMethod !== 'api_key' ||
    scope.principalId !== configured.orderPrincipalId ||
    scope.authenticationNamespaceId !== configured.orderNamespaceId ||
    scope.legalEntityId === undefined
  ) {
    return yield* unavailable('The caller is not the configured Order service in a Selling Legal Entity');
  }
  const { legalEntityId } = scope;
  const credentialFor = Effect.fn('PricingFinalization.ownerCredential')(function* ownerCredential(
    audience: 'commerce-cart' | 'commerce-order' | 'commerce-customer-context',
  ) {
    const issued = yield* issueApiKeyGatewayContext(
      {
        audience,
        compositionRevision,
        legalEntityId,
      },
      { apiKey: configured.apiKey, baseUrl: configured.shellBaseUrl, requestCorrelation: scope.correlationId },
    ).pipe(Effect.mapError(unavailable));
    if (issued.compositionRevision !== compositionRevision) {
      return yield* unavailable('Owner credential belongs to a different active composition');
    }
    return { baseUrl: new URL(issued.apiBaseUrl, configured.shellBaseUrl), credential: `Bearer ${issued.token}` };
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
      candidate.legalEntityId !== scope.legalEntityId
    ) {
      return yield* unavailable('Cart returned a different immutable final candidate');
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

/** Explicit service delegation: CCC independently admits Pricing against a retained approved buyer context. */
export const pricingFinalizationCustomerContextGatewayIssuerLive = Layer.succeed(
  CurrentPricingDecisionCustomerContextGatewayIssuer,
  {
    issue: Effect.fn('PricingFinalizationCustomerContext.issue')(
      (input: Parameters<CurrentPricingDecisionCustomerContextGatewayIssuerService['issue']>[0]) =>
        Effect.gen(function* issueCustomerContextCredential() {
          const preapproval = yield* Config.all({
            namespace: Config.String('ONTOS_PRICING_PREPROPOSAL_NAMESPACE_ID'),
            principal: Config.String('ONTOS_PRICING_PREPROPOSAL_PRINCIPAL_ID'),
          }).pipe(Effect.option);
          if (
            Option.isSome(preapproval) &&
            input.principal.principalId === preapproval.value.principal &&
            input.principal.authenticationNamespaceId === preapproval.value.namespace &&
            input.principal.authMethod === 'api_key' &&
            input.principal.impersonatedByPrincipalId === undefined &&
            input.principal.legalEntityId !== undefined
          ) {
            const configured = yield* Config.all({
              apiKey: Config.Redacted('ONTOS_PRICING_GATEWAY_API_KEY'),
              shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
            });
            const issued = yield* issueApiKeyGatewayContext(
              {
                audience: 'commerce-customer-context',
                compositionRevision: input.compositionRevision,
                legalEntityId: input.principal.legalEntityId,
              },
              {
                apiKey: configured.apiKey,
                baseUrl: configured.shellBaseUrl,
                requestCorrelation: input.requestCorrelation,
              },
            );
            if (
              issued.compositionRevision !== input.compositionRevision ||
              issued.expiresAt * 1000 <= DateTime.toEpochMillis(yield* DateTime.now)
            ) {
              return yield* unavailable('Stale preapproval gateway');
            }
            return {
              baseUrl: new URL(issued.apiBaseUrl, configured.shellBaseUrl),
              credential: Redacted.make(`Bearer ${issued.token}`),
            };
          }
          const owners = yield* pricingFinalizationOwnerGateways(
            { ...input.principal, correlationId: input.requestCorrelation },
            input.compositionRevision,
          );
          const owner = yield* owners.credentialFor('commerce-customer-context');
          return { baseUrl: owner.baseUrl, credential: Redacted.make(owner.credential) };
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CurrentPricingDecisionCustomerContextGatewayUnavailable({
                cause,
                reason: 'GATEWAY_ISSUER_UNAVAILABLE',
              }),
          ),
        ),
    ),
  },
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
  ) {
    if (input.candidateHash === undefined) {
      return yield* unavailable('Final Cart candidate hash is required');
    }
    const owners = yield* pricingFinalizationOwnerGateways(scope, compositionRevision);
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
