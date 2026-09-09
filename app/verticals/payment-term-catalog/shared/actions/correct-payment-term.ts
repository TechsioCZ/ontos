import { Schema } from 'effect';
import {
  PaymentTermCompatibilityIdSchema,
  PaymentTermDescriptionSchema,
  PaymentTermDefinitionRevisionIdSchema,
  PaymentTermNameSchema,
  PaymentTermReasonSchema,
  PaymentTermRevisionIdSchema,
} from '../domain/payment-term.ts';
import { PaymentTermRefSchema } from '../resources/payment-term.ts';

export const CorrectPaymentTermPayloadSchema = Schema.Struct({
  description: PaymentTermDescriptionSchema,
  expectedMetadataRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  name: PaymentTermNameSchema,
  paymentTermRef: PaymentTermRefSchema,
  reason: PaymentTermReasonSchema,
});
export type CorrectPaymentTermPayload = typeof CorrectPaymentTermPayloadSchema.Type;

export const CorrectPaymentTermResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  compatibilityId: PaymentTermCompatibilityIdSchema,
  definitionRevisionId: PaymentTermDefinitionRevisionIdSchema,
  metadataRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  paymentTermRef: PaymentTermRefSchema,
  semanticRevisionId: PaymentTermRevisionIdSchema,
});
export type CorrectPaymentTermResult = typeof CorrectPaymentTermResultSchema.Type;
