import type { OperationalScope } from '@app/core-runtime';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Context, DateTime, Effect, Option, Schema } from 'effect';

import { PaymentPurchasingContextSchema } from '../../shared/domain/applicability-purchasing-context.ts';
import type { PaymentPurchasingContext } from '../../shared/domain/applicability-purchasing-context.ts';
import type { PaymentAuthorizationBinding } from '../../shared/domain/authorization-proof.ts';
import type { PaymentCommitmentAttemptEvidence } from '../../shared/domain/commitment-attempt-evidence.ts';
import { PaymentMonetaryAmountSchema } from '../../shared/domain/payment-money.ts';
import { ownerEvidenceUnavailable } from './owner-evidence-unavailable.ts';
import type { PaymentOwnerEvidenceUnavailable, PaymentOwnerScope } from './owner-evidence-unavailable.ts';

export interface CommitmentAttemptEvidenceService {
  readonly findCurrentAttempt: (input: {
    readonly operationScope?: OperationalScope | undefined;
    readonly orderCommitmentAttemptId: string;
    readonly scope: PaymentOwnerScope;
  }) => Effect.Effect<Option.Option<PaymentCommitmentAttemptEvidence>, PaymentOwnerEvidenceUnavailable>;
}

export class CommitmentAttemptEvidencePort extends Context.Service<
  CommitmentAttemptEvidencePort,
  CommitmentAttemptEvidenceService
>()('@app/payment/ports/commitment-attempt-evidence-port/CommitmentAttemptEvidencePort') {}

export const unavailableCommitmentAttemptEvidence: CommitmentAttemptEvidenceService = Object.freeze({
  findCurrentAttempt: () =>
    Effect.fail(
      ownerEvidenceUnavailable('COMMITMENT_ATTEMPT', 'No Order Commitment Attempt evidence route is configured'),
    ),
});

const sameAmount = Schema.toEquivalence(PaymentMonetaryAmountSchema);
const samePurchase = Schema.toEquivalence(PaymentPurchasingContextSchema);
const sameTermRef = Schema.toEquivalence(PaymentTermRefSchema);

export const findCurrentCommitmentAttempt = Effect.fn('Payment.findCurrentCommitmentAttempt')(
  function* findCurrentCommitmentAttempt(
    orderCommitmentAttemptId: string,
    scope: PaymentOwnerScope,
    operationScope?: OperationalScope,
  ) {
    const owner = yield* Effect.serviceOption(CommitmentAttemptEvidencePort);
    return yield* Option.getOrElse(owner, () => unavailableCommitmentAttemptEvidence).findCurrentAttempt({
      operationScope,
      orderCommitmentAttemptId,
      scope,
    });
  },
);

export const matchesCommitmentAttempt = (
  evidence: PaymentCommitmentAttemptEvidence,
  binding: PaymentAuthorizationBinding,
  purchasingContext: PaymentPurchasingContext,
  scope: PaymentOwnerScope,
): boolean =>
  evidence.tenantId === scope.tenantId &&
  evidence.legalEntityId === scope.legalEntityId &&
  evidence.orderCommitmentAttemptId === binding.orderCommitmentAttemptId &&
  evidence.paymentId === binding.paymentId &&
  evidence.purchaseCorrelationId === binding.purchaseCorrelationId &&
  DateTime.Equivalence(evidence.orderCommitmentTime, binding.orderCommitmentTime) &&
  sameAmount(evidence.amount, binding.amount) &&
  sameTermRef(evidence.paymentTermRef, binding.paymentTermRef) &&
  samePurchase(evidence.purchasingContext, purchasingContext);
