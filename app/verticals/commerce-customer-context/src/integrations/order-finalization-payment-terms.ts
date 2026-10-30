import { OperationContextUnavailable, ReadHandlerUnavailable } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import type { FinalCartCandidate } from '@app/commerce-cart-finalization-contracts/final-candidate';
import { DateTime, Effect, Schema, Predicate } from 'effect';
import { PaymentTermsResolutionRequestSchema } from '../../shared/apis/payment-terms-resolution.ts';
import type { PaymentTermsResolutionResponse } from '../../shared/apis/payment-terms-resolution.ts';
import type { PurchaseApprovalRequest } from '../../shared/domain/purchasing-approval.ts';
import { paymentTermsPersistenceForTransaction } from '../persistence/payment-term-persistence.ts';
import { customerCommercePolicyAdministrationServiceFactory } from '../services/customer-commerce-policy-administration.service.ts';
import { customerCommercePaymentTermsPolicyResolver } from './customer-commerce-payment-terms-policy.ts';
import { paymentTermCatalogPortFromEnvironment } from './payment-term-catalog.ts';

const unavailable = (cause: unknown) => {
  const error = new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'The approved purchase Payment Terms cannot currently be established',
  });
  Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause, writable: false });
  return error;
};
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

const approvedPurchaseMatchesCart = ({
  actualScope,
  approvedRequest,
  candidate,
  legalEntityId,
}: {
  readonly actualScope: OperationalScope;
  readonly approvedRequest: PurchaseApprovalRequest;
  readonly candidate: FinalCartCandidate;
  readonly legalEntityId: string;
}): boolean => {
  const { proposal } = approvedRequest;
  const { decision, subject } = candidate.pricing;
  return (
    subject.kind === 'PROFILE' &&
    subject.authorizationSubject.kind === 'COUNTERPARTY' &&
    candidate.tenantId === actualScope.tenantId &&
    candidate.legalEntityId === legalEntityId &&
    approvedRequest.status === 'APPROVED' &&
    candidate.buyerPrincipalId === proposal.identity.buyer.principalId &&
    proposal.identity.buyer.tenantId === actualScope.tenantId &&
    sameRef(candidate.approval.requestRef, approvedRequest.requestRef) &&
    sameRef(candidate.approval.proposalRevisionRef, proposal.proposalRevisionRef) &&
    candidate.approval.proposalHash === proposal.canonicalHash &&
    sameRef(subject.profileRef, proposal.identity.profileRef) &&
    sameRef(subject.authorizationSubject.counterpartyRef, proposal.identity.counterpartyRef) &&
    candidate.storefrontId === proposal.context.storefrontId &&
    decision.commercialScope.channelId === proposal.context.channelId &&
    decision.commercialScope.marketId === proposal.context.marketId &&
    decision.commercialScope.sellingLegalEntityId === proposal.context.sellingLegalEntityId
  );
};

/** Called only after the public owner read authorizes the Order service and verifies the actual Cart candidate.
 * The candidate supplies business buyer/Storefront identity. The invoking service's Core scope stays unchanged.
 */
export const resolveOrderFinalizationPaymentTerms = Effect.fn('OrderFinalizationPaymentTerms.resolve')(
  function* resolveOrderFinalizationPaymentTerms(
    transaction: ScopedTransactionExecutor,
    actualScope: OperationalScope,
    approvedRequest: PurchaseApprovalRequest,
    candidate: FinalCartCandidate,
    compositionRevision: string,
  ): Effect.fn.Return<PaymentTermsResolutionResponse, ReadHandlerUnavailable | OperationContextUnavailable> {
    const { legalEntityId } = actualScope;
    if (legalEntityId === undefined) {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Order finalization requires an actual scoped Legal Entity',
      });
    }
    const { proposal } = approvedRequest;
    const { decision, subject } = candidate.pricing;
    if (subject.kind !== 'PROFILE' || subject.authorizationSubject.kind !== 'COUNTERPARTY') {
      return yield* unavailable('The approved Counterparty purchase requires its genuine profile subject');
    }
    if (!approvedPurchaseMatchesCart({ actualScope, approvedRequest, candidate, legalEntityId })) {
      return yield* unavailable('The owner-approved purchase and genuine Cart business subject do not match');
    }
    const at = DateTime.formatIso(candidate.orderCommitmentTime);
    const input = yield* Schema.decodeUnknownEffect(Schema.toType(PaymentTermsResolutionRequestSchema))({
      at,
      authorizationSubject: subject.authorizationSubject,
      explicitChoice: proposal.paymentTerm.definitionRef,
      profileRef: subject.profileRef,
      purchasingContext: {
        channelId: decision.commercialScope.channelId,
        contextRevision: decision.purchasingContext.contextRevision,
        marketId: decision.commercialScope.marketId,
        sellingLegalEntityId: legalEntityId,
        storefrontId: candidate.storefrontId,
      },
    }).pipe(Effect.mapError(unavailable));
    const { catalog, policyService } = yield* Effect.all(
      {
        catalog: paymentTermCatalogPortFromEnvironment({
          compositionRevision,
          legalEntityId,
          requestCorrelation: actualScope.correlationId,
        }),
        policyService: customerCommercePolicyAdministrationServiceFactory(
          transaction,
          actualScope,
          compositionRevision,
        ).pipe(Effect.mapError(unavailable)),
      },
      { concurrency: 2 },
    );
    // This is an independently verified business subject, not an authentication or OperationalScope override.
    const policy = customerCommercePaymentTermsPolicyResolver(
      'PROFILE',
      { tenantId: actualScope.tenantId, trustedStorefrontId: candidate.storefrontId },
      policyService,
    );
    const { resolution } = paymentTermsPersistenceForTransaction(
      { invoker: transaction, scope: { ...actualScope, legalEntityId } },
      { catalog, policy },
    );
    const result = yield* resolution.resolve(input);
    if (
      (Predicate.isTagged(result, 'EXPLICIT_CHOICE') ||
        Predicate.isTagged(result, 'PREFERRED_ENTITLEMENT') ||
        Predicate.isTagged(result, 'POLICY_FALLBACK')) &&
      (!sameRef(result.definition.paymentTermRef, proposal.paymentTerm.definitionRef) ||
        result.definition.code !== proposal.paymentTerm.code ||
        result.definition.definitionRevisionId !== proposal.paymentTerm.definitionRevision)
    ) {
      return yield* unavailable('The resolved Payment Term no longer matches the exact approved definition');
    }
    return result;
  },
);
