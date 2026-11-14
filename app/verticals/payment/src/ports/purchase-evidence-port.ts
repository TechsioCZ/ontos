import type { PaymentTermsResolutionRequest } from '@app/commerce-customer-context/api/payment-terms-resolution';
import type { OperationalScope } from '@app/core-runtime';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Context, Effect } from 'effect';

import type { PaymentPurchasingContext } from '../../shared/domain/applicability-purchasing-context.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import { ownerEvidenceUnavailable } from './owner-evidence-unavailable.ts';
import type { PaymentOwnerEvidenceUnavailable } from './owner-evidence-unavailable.ts';

/** Current purchasing-owner evidence for the verified actor and one exact Purchase Payable Amount. */
export interface PaymentPurchaseEvidence {
  readonly authorizationSubject?: PaymentTermsResolutionRequest['authorizationSubject'];
  readonly customerConfigurationId: string;
  readonly evidenceRef: string;
  readonly legalEntityId: string;
  readonly payableAmount: PaymentMonetaryAmount;
  readonly paymentTermRef: PaymentTermRef;
  readonly principalId: string;
  readonly purchaseCorrelationId: string;
  readonly purchasingContext: PaymentPurchasingContext;
  readonly storefrontId: string;
  readonly tenantId: string;
}

export interface PaymentPurchaseEvidenceService {
  /** The submitted context is a lookup selector. The owner returns its own Current purchase and subject. */
  readonly readCurrent: (input: {
    readonly purchasingContext: PaymentPurchasingContext;
    readonly scope: OperationalScope;
  }) => Effect.Effect<PaymentPurchaseEvidence, PaymentOwnerEvidenceUnavailable>;
}

const unavailablePurchaseEvidence: PaymentPurchaseEvidenceService = Object.freeze({
  readCurrent: () =>
    Effect.fail(
      ownerEvidenceUnavailable('PAYMENT_TERM_EVIDENCE', 'No Current Checkout purchasing-evidence route is configured'),
    ),
});

/** Deferred Checkout supplies the facts for Payment applicability and intent creation (#1147/#1148). */
export const PaymentPurchaseEvidencePort = Context.Reference<PaymentPurchaseEvidenceService>(
  '@app/payment/ports/purchase-evidence-port/PaymentPurchaseEvidencePort',
  { defaultValue: () => unavailablePurchaseEvidence },
);
