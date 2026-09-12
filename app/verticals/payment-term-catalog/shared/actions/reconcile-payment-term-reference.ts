import { Schema } from 'effect';
import { PaymentTermReasonSchema } from '../domain/payment-term.ts';
import { PaymentTermRefSchema } from '../resources/payment-term.ts';

export const ReconcilePaymentTermReferencePayloadSchema = Schema.Struct({
  aliasPaymentTermRef: PaymentTermRefSchema,
  canonicalPaymentTermRef: PaymentTermRefSchema,
  expectedAliasMetadataRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  expectedCanonicalMetadataRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  reason: PaymentTermReasonSchema,
});
export type ReconcilePaymentTermReferencePayload = typeof ReconcilePaymentTermReferencePayloadSchema.Type;

export const ReconcilePaymentTermReferenceResultSchema = Schema.Struct({
  aliasPaymentTermRef: PaymentTermRefSchema,
  canonicalPaymentTermRef: PaymentTermRefSchema,
  changed: Schema.Boolean,
});
