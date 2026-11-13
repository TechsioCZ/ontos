import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Schema } from 'effect';

import { PaymentPurchasingContextSchema } from './applicability-purchasing-context.ts';
import {
  PaymentEvidenceRefSchema,
  PaymentIdSchema,
  PaymentLegalEntityIdSchema,
  PaymentOrderCommitmentAttemptIdSchema,
  PaymentPurchaseCorrelationIdSchema,
  PaymentTenantIdSchema,
} from './payment-identifiers.ts';
import { PaymentMonetaryAmountSchema } from './payment-money.ts';

/** Current evidence from the owner of one exact Order Commitment Attempt (#1149). */
export const PaymentCommitmentAttemptEvidenceSchema = Schema.Struct({
  amount: PaymentMonetaryAmountSchema,
  evidenceRef: PaymentEvidenceRefSchema,
  legalEntityId: PaymentLegalEntityIdSchema,
  orderCommitmentAttemptId: PaymentOrderCommitmentAttemptIdSchema,
  orderCommitmentTime: Schema.DateTimeUtcFromString,
  paymentId: PaymentIdSchema,
  paymentTermRef: PaymentTermRefSchema,
  purchaseCorrelationId: PaymentPurchaseCorrelationIdSchema,
  purchasingContext: PaymentPurchasingContextSchema,
  tenantId: PaymentTenantIdSchema,
  validUntil: Schema.DateTimeUtcFromString,
});
export type PaymentCommitmentAttemptEvidence = typeof PaymentCommitmentAttemptEvidenceSchema.Type;
