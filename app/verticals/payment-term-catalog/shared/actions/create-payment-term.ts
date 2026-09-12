import { Schema } from 'effect';
import {
  PaymentTermCodeSchema,
  PaymentTermCompatibilityIdSchema,
  PaymentTermDescriptionSchema,
  PaymentTermDefinitionRevisionIdSchema,
  PaymentTermInstantSchema,
  PaymentTermNameSchema,
  PaymentTermReasonSchema,
  PaymentTermRevisionIdSchema,
  PaymentTermSemanticsSchema,
} from '../domain/payment-term.ts';
import { PaymentTermRefSchema } from '../resources/payment-term.ts';

export const CreatePaymentTermPayloadSchema = Schema.Struct({
  activeFrom: PaymentTermInstantSchema,
  code: PaymentTermCodeSchema,
  description: PaymentTermDescriptionSchema,
  name: PaymentTermNameSchema,
  reason: PaymentTermReasonSchema,
  semantics: PaymentTermSemanticsSchema,
});
export type CreatePaymentTermPayload = typeof CreatePaymentTermPayloadSchema.Type;

export const CreatePaymentTermResultSchema = Schema.Struct({
  compatibilityId: PaymentTermCompatibilityIdSchema,
  definitionRevisionId: PaymentTermDefinitionRevisionIdSchema,
  metadataRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  paymentTermRef: PaymentTermRefSchema,
  semanticRevisionId: PaymentTermRevisionIdSchema,
});
