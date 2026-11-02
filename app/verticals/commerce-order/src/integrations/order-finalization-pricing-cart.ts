import type { OrderFinalizationContext } from '../../shared/domain/order-finalization-evidence.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import {
  FinalCartCandidateRequestSchema,
  FinalCartCandidateSchema,
} from '@app/commerce-cart-finalization-contracts/final-candidate';
import type {
  FinalCartCandidate,
  FinalCartCandidateRequest,
} from '@app/commerce-cart-finalization-contracts/final-candidate';
import { executeFinalCartCandidateWithAuthorization } from '@app/commerce-cart-finalization-contracts/final-candidate/client';
import {
  PricingCommitmentConfirmationBindingSchema,
  PricingCommitmentConfirmationVerifiedSchema,
  PricingCommitmentConfirmationExpiredSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingCommitmentConfirmationBinding } from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { ManageCommitmentConfirmationActionAlreadyCommittedProblemSchema } from '@app/pricing-contracts/manage-commitment-confirmation/api';
import { executeManageCommitmentConfirmationWithAuthorization } from '@app/pricing-contracts/manage-commitment-confirmation/client';
import { executeCommitmentConfirmationVerificationWithAuthorization } from '@app/pricing-contracts/commitment-confirmation/client';
import { executeQuotationVerificationWithAuthorization } from '@app/pricing-contracts/quotation-verification/client';
import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Clock, Config, Context, DateTime, Effect, Layer, Option, Schema, Predicate } from 'effect';
import { OrderCommitmentRejected } from '../../shared/domain/order-commitment.ts';

type FinalizationScope = OrderFinalizationContext;
type QuotationOutcome = Effect.Success<ReturnType<typeof executeQuotationVerificationWithAuthorization>>;
type VerifiedQuotation = Extract<QuotationOutcome, { readonly outcome: 'QUOTATION_VERIFIED' }>;
/** Pricing's owner-proven terminal expiry of the exact retained Quotation. */
export type OrderQuotationExpired = Extract<QuotationOutcome, { readonly outcome: 'QUOTATION_EXPIRED' }>;
type VerifiedConfirmation = typeof PricingCommitmentConfirmationVerifiedSchema.Type;
type ExpiredConfirmation = typeof PricingCommitmentConfirmationExpiredSchema.Type;
type IssuedConfirmationResult = Effect.Success<ReturnType<typeof executeManageCommitmentConfirmationWithAuthorization>>;
export type OrderPricingProofOutcome = VerifiedConfirmation | typeof PricingCommitmentConfirmationExpiredSchema.Type;
export interface OrderQuotationVerificationInput {
  readonly candidate: FinalCartCandidate;
  readonly quotationRef: string;
}
export interface OrderQuotationConfirmationInput {
  readonly binding: PricingCommitmentConfirmationBinding;
  readonly idempotencyKey: string;
  readonly quotationRef: string;
}
export interface OrderFinalizationPricingCartService {
  readonly issueAndVerifyQuotationConfirmation: (
    input: OrderQuotationConfirmationInput,
    scope: FinalizationScope,
  ) => Effect.Effect<OrderPricingProofOutcome, OrderCommitmentRejected>;
  readonly loadCandidate: (
    input: FinalCartCandidateRequest,
    scope: FinalizationScope,
  ) => Effect.Effect<FinalCartCandidate, OrderCommitmentRejected>;
  readonly readQuotationConfirmationOutcome: (
    input: Omit<OrderQuotationConfirmationInput, 'idempotencyKey'> & { readonly confirmationRef: string },
    scope: FinalizationScope,
  ) => Effect.Effect<OrderPricingProofOutcome, OrderCommitmentRejected>;
  readonly verifyQuotation: (
    input: OrderQuotationVerificationInput,
    scope: FinalizationScope,
  ) => Effect.Effect<VerifiedQuotation | OrderQuotationExpired, OrderCommitmentRejected>;
  readonly verifyQuotationConfirmation: (
    input: Omit<OrderQuotationConfirmationInput, 'idempotencyKey'> & { readonly confirmationRef: string },
    scope: FinalizationScope,
  ) => Effect.Effect<VerifiedConfirmation, OrderCommitmentRejected>;
}
export class OrderFinalizationPricingCart extends Context.Service<
  OrderFinalizationPricingCart,
  OrderFinalizationPricingCartService
>()('@app/commerce-order/integrations/order-finalization-pricing-cart/OrderFinalizationPricingCart') {}

const unavailable = (cause: unknown = 'Finalization owner configuration is unavailable') => {
  const error = new OrderCommitmentRejected({
    code: 'order_commitment_unavailable',
    reason: 'The Cart or Pricing owner cannot currently verify exact Order finalization evidence',
  });
  Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause, writable: false });
  return error;
};
const conflict = () =>
  new OrderCommitmentRejected({
    code: 'order_commitment_conflict',
    reason: 'Cart or Pricing evidence does not match the exact Order candidate and binding',
  });
const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'A trusted HTTP(S) owner URL is required',
  ),
);
const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_ORDER_FINALIZATION_GATEWAY_API_KEY'),
  cartBaseUrl: Config.schema(httpUrl, 'ONTOS_COMMERCE_CART_API_BASE_URL'),
  pricingBaseUrl: Config.schema(httpUrl, 'ONTOS_PRICING_API_BASE_URL'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});
const sameCandidateRef = Schema.toEquivalence(FinalCartCandidateSchema.fields.candidateRef);
const samePricingDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameBinding = Schema.toEquivalence(PricingCommitmentConfirmationBindingSchema);
const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.tenantId === right.tenantId &&
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId;
const purchaseOutsideScope = (binding: PricingCommitmentConfirmationBinding, scope: FinalizationScope) =>
  binding.purchase.tenantId !== scope.tenantId ||
  binding.purchase.commercialScope.sellingLegalEntityId !== scope.legalEntityId ||
  binding.purchase.subject.kind !== 'AUTHENTICATED';
const isStaleObservation = (observed: number, now: number) => observed > now || now - observed > 30_000;
const expiredOutcomeInconsistent = (
  expired: ExpiredConfirmation,
  expectedConfirmationRef: string | undefined,
  now: number,
) => {
  const observed = DateTime.toEpochMillis(DateTime.makeUnsafe(expired.evaluatedAt));
  return (
    (expectedConfirmationRef !== undefined && expired.confirmationRef !== expectedConfirmationRef) ||
    isStaleObservation(observed, now) ||
    observed < DateTime.toEpochMillis(DateTime.makeUnsafe(expired.expiresAt))
  );
};
const expiredQuotationInconsistent = (expired: OrderQuotationExpired, quotationRef: string, now: number) => {
  const observed = DateTime.toEpochMillis(DateTime.makeUnsafe(expired.expired.evaluatedAt));
  return (
    expired.expired.quotationRef !== quotationRef ||
    expired.authenticityEvidence.quotationRef !== quotationRef ||
    expired.authenticityEvidence.verifiedAt !== expired.expired.evaluatedAt ||
    isStaleObservation(observed, now) ||
    observed < DateTime.toEpochMillis(DateTime.makeUnsafe(expired.expired.validity.validUntil))
  );
};
const verifiedOutcomeInconsistent = (
  verified: VerifiedConfirmation,
  expected: {
    readonly binding: PricingCommitmentConfirmationBinding;
    readonly confirmationRef: string | undefined;
    readonly quotationRef: string;
  },
  now: number,
) => {
  const { confirmation } = verified;
  const observed = DateTime.toEpochMillis(DateTime.makeUnsafe(verified.verifiedAt));
  return (
    (expected.confirmationRef !== undefined && confirmation.confirmationRef !== expected.confirmationRef) ||
    !sameBinding(confirmation.binding, expected.binding) ||
    confirmation.source.kind !== 'QUOTATION_BACKED' ||
    confirmation.source.quotationRevalidation.quotation.quotationRef !== expected.quotationRef ||
    isStaleObservation(observed, now) ||
    now >= DateTime.toEpochMillis(DateTime.makeUnsafe(confirmation.expiresAt))
  );
};
const issuedConfirmationRef = (result: IssuedConfirmationResult | undefined) =>
  result?.kind === 'ISSUE_QUOTATION_BACKED_CONFIRMATION' && Predicate.isTagged(result.outcome, 'ISSUED')
    ? result.outcome.confirmationRef
    : undefined;
const confirmationVerificationRequest = (
  input: OrderQuotationConfirmationInput,
  recoveryInvocationId: string | undefined,
  confirmationRef: string | undefined,
) => {
  if (recoveryInvocationId !== undefined) {
    return {
      issuanceInvocationId: recoveryInvocationId,
      quotationRef: input.quotationRef,
      requestedBinding: input.binding,
    };
  }
  return confirmationRef === undefined
    ? undefined
    : { confirmationRef, quotationRef: input.quotationRef, requestedBinding: input.binding };
};
const candidateMatchesScope = (candidate: FinalCartCandidate, scope: FinalizationScope) =>
  candidate.tenantId === scope.tenantId &&
  candidate.legalEntityId === scope.legalEntityId &&
  candidate.buyerPrincipalId === scope.buyerPrincipalId;

export const OrderFinalizationPricingCartLive = Layer.effect(
  OrderFinalizationPricingCart,
  Effect.gen(function* orderFinalizationPricingCartLayer() {
    const composition = yield* ActiveApplicationCompositionService;
    const configured = yield* configuration.pipe(Effect.match({ onFailure: Option.none, onSuccess: Option.some }));
    const credential = Effect.fn('OrderFinalizationPricingCart.credential')(function* credential(
      audience: 'commerce-cart' | 'pricing',
      scope: FinalizationScope,
    ) {
      if (Option.isNone(configured)) {
        return yield* unavailable();
      }
      const active = yield* composition.load.pipe(
        Effect.flatMap(validateActiveApplicationCompositionSnapshot),
        Effect.mapError(unavailable),
      );
      const issued = yield* issueApiKeyGatewayContext(
        { audience, compositionRevision: active.composition.revision, legalEntityId: scope.legalEntityId },
        {
          apiKey: configured.value.apiKey,
          baseUrl: configured.value.shellBaseUrl,
          requestCorrelation: scope.correlationId,
        },
      ).pipe(Effect.mapError(unavailable));
      if (
        issued.compositionRevision !== active.composition.revision ||
        issued.expiresAt * 1000 <= (yield* Clock.currentTimeMillis)
      ) {
        return yield* unavailable('The owner credential is expired or bound to a different active composition');
      }
      return {
        authorization: `Bearer ${issued.token}`,
        baseUrl: audience === 'commerce-cart' ? configured.value.cartBaseUrl : configured.value.pricingBaseUrl,
        compositionRevision: active.composition.revision,
      };
    });
    const readQuotationConfirmationOutcome = Effect.fn('OrderFinalizationPricingCart.readQuotationConfirmationOutcome')(
      function* readQuotationConfirmationOutcome(
        input: Omit<OrderQuotationConfirmationInput, 'idempotencyKey'> & { readonly confirmationRef: string },
        scope: FinalizationScope,
      ) {
        if (purchaseOutsideScope(input.binding, scope)) {
          return yield* conflict();
        }
        const authorization = yield* credential('pricing', scope);
        // Pricing proves full requested binding, original source Quotation and retained
        // authenticity before either VERIFIED or the terminal EXPIRED response.
        const result = yield* executeCommitmentConfirmationVerificationWithAuthorization(
          { confirmationRef: input.confirmationRef, quotationRef: input.quotationRef, requestedBinding: input.binding },
          authorization.authorization,
          scope.correlationId,
          authorization,
        ).pipe(Effect.mapError(unavailable));
        const now = yield* Clock.currentTimeMillis;
        if (Predicate.isTagged(result, 'EXPIRED')) {
          const expired = yield* Schema.decodeEffect(Schema.toType(PricingCommitmentConfirmationExpiredSchema))(
            result,
          ).pipe(Effect.mapError(unavailable));
          if (expiredOutcomeInconsistent(expired, input.confirmationRef, now)) {
            return yield* conflict();
          }
          return expired;
        }
        if (!Predicate.isTagged(result, 'VERIFIED')) {
          return yield* unavailable(result);
        }
        const verified = yield* Schema.decodeEffect(Schema.toType(PricingCommitmentConfirmationVerifiedSchema))(
          result,
        ).pipe(Effect.mapError(unavailable));
        if (
          verifiedOutcomeInconsistent(
            verified,
            { binding: input.binding, confirmationRef: input.confirmationRef, quotationRef: input.quotationRef },
            now,
          )
        ) {
          return yield* conflict();
        }
        return verified;
      },
    );
    return {
      issueAndVerifyQuotationConfirmation: Effect.fn(
        'OrderFinalizationPricingCart.issueAndVerifyQuotationConfirmation',
      )(function* issueAndVerifyQuotationConfirmation(
        input: OrderQuotationConfirmationInput,
        scope: FinalizationScope,
      ) {
        if (purchaseOutsideScope(input.binding, scope)) {
          return yield* conflict();
        }
        const issuanceAuthorization = yield* credential('pricing', scope);
        const issued = yield* executeManageCommitmentConfirmationWithAuthorization(
          {
            binding: input.binding,
            kind: 'ISSUE_QUOTATION_BACKED_CONFIRMATION',
            quotationRef: input.quotationRef,
            reason: 'Verify exact quotation-backed Order commitment',
            schemaVersion: '1',
          },
          issuanceAuthorization.authorization,
          scope.correlationId,
          { ...issuanceAuthorization, idempotencyKey: input.idempotencyKey },
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ error, failed: true as const }),
            onSuccess: (result) => ({ failed: false as const, result }),
          }),
        );
        const recovery =
          issued.failed && Schema.is(ManageCommitmentConfirmationActionAlreadyCommittedProblemSchema)(issued.error)
            ? issued.error
            : undefined;
        if (issued.failed && recovery === undefined) {
          return yield* unavailable(issued.error);
        }
        const confirmationRef = issuedConfirmationRef(issued.failed ? undefined : issued.result);
        if (!issued.failed && confirmationRef === undefined) {
          return yield* unavailable(issued.result);
        }
        const verificationRequest = confirmationVerificationRequest(input, recovery?.invocationId, confirmationRef);
        if (verificationRequest === undefined) {
          return yield* unavailable();
        }
        const expectedConfirmationRef =
          'confirmationRef' in verificationRequest ? verificationRequest.confirmationRef : undefined;
        // A new assertion is mandatory for this separate read, including retries after durable issuance.
        const verificationAuthorization = yield* credential('pricing', scope);
        if (verificationAuthorization.compositionRevision !== issuanceAuthorization.compositionRevision) {
          return yield* unavailable('Active composition changed during Pricing confirmation issuance');
        }
        const outcome = yield* executeCommitmentConfirmationVerificationWithAuthorization(
          verificationRequest,
          verificationAuthorization.authorization,
          scope.correlationId,
          verificationAuthorization,
        ).pipe(Effect.mapError(unavailable));
        if (Predicate.isTagged(outcome, 'EXPIRED')) {
          const expired = yield* Schema.decodeEffect(Schema.toType(PricingCommitmentConfirmationExpiredSchema))(
            outcome,
          ).pipe(Effect.mapError(unavailable));
          const now = yield* Clock.currentTimeMillis;
          if (expiredOutcomeInconsistent(expired, expectedConfirmationRef, now)) {
            return yield* conflict();
          }
          return expired;
        }
        if (!Predicate.isTagged(outcome, 'VERIFIED')) {
          return yield* unavailable(outcome);
        }
        const verified = yield* Schema.decodeEffect(Schema.toType(PricingCommitmentConfirmationVerifiedSchema))(
          outcome,
        ).pipe(Effect.mapError(unavailable));
        const now = yield* Clock.currentTimeMillis;
        if (
          verifiedOutcomeInconsistent(
            verified,
            { binding: input.binding, confirmationRef: expectedConfirmationRef, quotationRef: input.quotationRef },
            now,
          )
        ) {
          return yield* conflict();
        }
        // Confirmation stays outside the immutable Bundle; its exact Attempt/Bundle binding is verified above.
        return verified;
      }),
      loadCandidate: Effect.fn('OrderFinalizationPricingCart.loadCandidate')(function* loadCandidate(
        input: FinalCartCandidateRequest,
        scope: FinalizationScope,
      ) {
        if (
          !Schema.is(FinalCartCandidateRequestSchema.members[0])(input) ||
          input.candidateRef.tenantId !== scope.tenantId
        ) {
          return yield* conflict();
        }
        const authorization = yield* credential('commerce-cart', scope);
        const candidate = yield* executeFinalCartCandidateWithAuthorization(
          input,
          authorization.authorization,
          scope.correlationId,
          authorization,
        ).pipe(Effect.mapError(unavailable));
        if (
          !candidateMatchesScope(candidate, scope) ||
          !sameCandidateRef(candidate.candidateRef, input.candidateRef) ||
          candidate.candidateHash !== input.candidateHash
        ) {
          return yield* conflict();
        }
        return candidate;
      }),
      readQuotationConfirmationOutcome,
      verifyQuotation: Effect.fn('OrderFinalizationPricingCart.verifyQuotation')(function* verifyQuotation(
        input: OrderQuotationVerificationInput,
        scope: FinalizationScope,
      ) {
        const { candidate } = input;
        if (!candidateMatchesScope(candidate, scope)) {
          return yield* conflict();
        }
        const candidateRef = yield* Schema.decodeUnknownEffect(CoreSearchResourceRefSchema)(
          candidate.candidateRef,
        ).pipe(Effect.mapError(unavailable));
        const authorization = yield* credential('pricing', scope);
        // Pricing loads its immutable Quotation and the Cart-owned candidate itself. Forwarded Quotation objects confer no authority.
        const verified = yield* executeQuotationVerificationWithAuthorization(
          {
            candidateHash: candidate.candidateHash,
            candidateRef,
            quotationRef: input.quotationRef,
          },
          authorization.authorization,
          scope.correlationId,
          authorization,
        ).pipe(Effect.mapError(unavailable));
        const now = yield* Clock.currentTimeMillis;
        if (verified.outcome === 'QUOTATION_EXPIRED') {
          // Only a fresh owner observation of this exact authentic Quotation is terminal.
          return expiredQuotationInconsistent(verified, input.quotationRef, now) ? yield* conflict() : verified;
        }
        const { authenticityEvidence, quotation } = verified;
        const { subject } = candidate.pricing;
        const { binding } = quotation;
        const observed = DateTime.toEpochMillis(DateTime.makeUnsafe(authenticityEvidence.verifiedAt));
        if (
          quotation.quotationRef !== input.quotationRef ||
          verified.pricingResultRef.pricingResultId !== input.quotationRef ||
          verified.pricingResultRef.revision !== 1 ||
          authenticityEvidence.quotationRef !== input.quotationRef ||
          observed > now ||
          now - observed > 30_000 ||
          now < DateTime.toEpochMillis(DateTime.makeUnsafe(quotation.validity.validFrom)) ||
          now >= DateTime.toEpochMillis(DateTime.makeUnsafe(quotation.validity.validUntil))
        ) {
          return yield* conflict();
        }
        // Pricing evaluates at operation time and issues once its final material validation completes,
        // never earlier. Cart's frozen business T remains unchanged; every other purchase/context/material
        // field must match the actual retained candidate.
        const pricingDecision = quotation.quotedResult.decision;
        if (
          binding.candidateRef !== candidate.candidateRef.resourceId ||
          binding.tenantId !== scope.tenantId ||
          binding.commercialScope.sellingLegalEntityId !== scope.legalEntityId ||
          binding.subject.kind !== 'AUTHENTICATED' ||
          subject.kind !== 'PROFILE' ||
          !sameRef(binding.subject.subjectRef, subject.profileRef) ||
          DateTime.toEpochMillis(DateTime.makeUnsafe(quotation.issuedAt)) <
            DateTime.toEpochMillis(DateTime.makeUnsafe(pricingDecision.operationTime)) ||
          !samePricingDecision(pricingDecision, {
            ...candidate.pricing.decision,
            operationTime: pricingDecision.operationTime,
          })
        ) {
          return yield* conflict();
        }
        return verified;
      }),
      verifyQuotationConfirmation: (
        input: Omit<OrderQuotationConfirmationInput, 'idempotencyKey'> & { readonly confirmationRef: string },
        scope: FinalizationScope,
      ) =>
        readQuotationConfirmationOutcome(input, scope).pipe(
          Effect.flatMap((outcome) =>
            Predicate.isTagged(outcome, 'VERIFIED') ? Effect.succeed(outcome) : Effect.fail(conflict()),
          ),
        ),
    } satisfies OrderFinalizationPricingCartService;
  }),
);
