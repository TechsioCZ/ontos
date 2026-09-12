import { Schema } from 'effect';
import {
  PaymentTermAffectedUseAssessmentSchema,
  PaymentTermAffectedUseDispositionSchema,
  PaymentTermCompatibilityIdSchema,
  PaymentTermDefinitionRevisionIdSchema,
  PaymentTermInstantSchema,
  PaymentTermReasonSchema,
  PaymentTermRevisionIdSchema,
} from '../domain/payment-term.ts';
import { PaymentTermRefSchema } from '../resources/payment-term.ts';

export const RetirePaymentTermPayloadSchema = Schema.Struct({
  affectedUseAssessment: PaymentTermAffectedUseAssessmentSchema,
  affectedUseDisposition: PaymentTermAffectedUseDispositionSchema,
  effectiveAt: PaymentTermInstantSchema,
  expectedMetadataRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  paymentTermRef: PaymentTermRefSchema,
  reason: PaymentTermReasonSchema,
});
export type RetirePaymentTermPayload = typeof RetirePaymentTermPayloadSchema.Type;

export const RetirePaymentTermResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  compatibilityId: PaymentTermCompatibilityIdSchema,
  definitionRevisionId: PaymentTermDefinitionRevisionIdSchema,
  metadataRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  paymentTermRef: PaymentTermRefSchema,
  retiredEffectiveAt: PaymentTermInstantSchema,
  semanticRevisionId: PaymentTermRevisionIdSchema,
});
export type RetirePaymentTermResult = typeof RetirePaymentTermResultSchema.Type;
