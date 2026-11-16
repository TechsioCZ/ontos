import type { OperationalScope } from '@app/core-runtime';
import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Context, Effect, Schema } from 'effect';

import { PaymentPurchasingContextSchema } from '../../shared/domain/applicability-purchasing-context.ts';
import { PaymentEvidenceRefSchema } from '../../shared/domain/payment-identifiers.ts';
import type { PaymentMethod } from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import { ownerEvidenceUnavailable } from './owner-evidence-unavailable.ts';
import type { PaymentOwnerEvidenceUnavailable, PaymentOwnerScope } from './owner-evidence-unavailable.ts';

/** Why an exact term/entitlement is not usable for this purchase; a definitive owner fact, not an outage. */
export const PAYMENT_TERM_NOT_USABLE_REASONS = [
  'TERM_NOT_FOUND',
  'TERM_RETIRED',
  'TERM_SEMANTICS_INCOMPATIBLE',
  'ENTITLEMENT_NOT_CURRENT',
  'POLICY_DENIED',
] as const;
export const PaymentTermNotUsableReasonSchema = Schema.Literals(PAYMENT_TERM_NOT_USABLE_REASONS);

/**
 * C15 exact reusable semantic snapshot plus the Commerce Customer Context Current entitlement/policy
 * decision for one exact `PaymentTermRef` (#1147). Payment never re-derives either.
 */
export const PaymentTermUseEvidenceSchema = Schema.Union([
  Schema.TaggedStruct('USABLE', {
    entitlementEvidenceRef: PaymentEvidenceRefSchema,
    paymentTermRef: PaymentTermRefSchema,
    semanticSnapshot: PaymentTermDefinitionSnapshotSchema,
  }),
  Schema.TaggedStruct('NOT_USABLE', {
    paymentTermRef: PaymentTermRefSchema,
    reason: PaymentTermNotUsableReasonSchema,
  }),
]);
export type PaymentTermUseEvidence = typeof PaymentTermUseEvidenceSchema.Type;

/**
 * The exact purchase whose Current Customer Context entitlement/policy the owner decides; the merchant
 * `customerConfigurationId` never identifies the buyer. It is always the trusted Commerce Purchasing
 * Context (buyer, Channel, Commerce Market): the request's own before an intent exists (#1147), and the
 * one the Payment stored immutably at creation afterwards (#1148, #1149).
 */
export const PaymentTermPurchaseSchema = Schema.TaggedStruct('PURCHASING_CONTEXT', {
  purchasingContext: PaymentPurchasingContextSchema,
});
export type PaymentTermPurchase = typeof PaymentTermPurchaseSchema.Type;

/** The registered operation requesting Current term evidence for a specific purchase. */
export interface PaymentTermOwnerCall {
  readonly consumer: 'APPLICABILITY' | 'CREATE' | 'ISSUE' | 'VALIDATE';
  readonly operationScope: OperationalScope;
  readonly payableAmount: PaymentMonetaryAmount;
  readonly purchaseCorrelationId?: string | undefined;
}

export interface PaymentTermEvidenceService {
  readonly verifyTermUse: (input: {
    readonly customerConfigurationId: string;
    readonly method: PaymentMethod;
    readonly ownerCall?: PaymentTermOwnerCall;
    readonly paymentTermRef: PaymentTermRef;
    readonly purchase: PaymentTermPurchase;
    readonly scope: PaymentOwnerScope;
  }) => Effect.Effect<PaymentTermUseEvidence, PaymentOwnerEvidenceUnavailable>;
}

/** C15 + CCC owner evidence for one exact term use (L1, L2, L3). */
export class PaymentTermEvidencePort extends Context.Service<PaymentTermEvidencePort, PaymentTermEvidenceService>()(
  '@app/payment/ports/payment-term-evidence-port/PaymentTermEvidencePort',
) {}

export const unavailablePaymentTermEvidence: PaymentTermEvidenceService = Object.freeze({
  verifyTermUse: () =>
    Effect.fail(
      ownerEvidenceUnavailable(
        'PAYMENT_TERM_EVIDENCE',
        'No Payment Term catalog and Customer Context entitlement evidence route is configured',
      ),
    ),
});
