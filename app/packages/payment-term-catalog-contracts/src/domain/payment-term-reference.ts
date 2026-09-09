import { Schema } from 'effect';
import {
  PaymentTermCompatibilityIdSchema,
  PaymentTermConsumerCompatibilitySchema,
  PaymentTermDefinitionSchema,
  PaymentTermRevisionIdSchema,
} from './payment-term.ts';
import { PaymentTermRefSchema } from '../resources/payment-term.ts';

export const PaymentTermReferenceRequestSchema = Schema.Struct({
  expectedCompatibilityId: Schema.optionalKey(PaymentTermCompatibilityIdSchema),
  expectedConsumerCompatibility: Schema.optionalKey(PaymentTermConsumerCompatibilitySchema),
  expectedSemanticRevisionId: Schema.optionalKey(PaymentTermRevisionIdSchema),
  paymentTermRef: PaymentTermRefSchema,
});
export type PaymentTermReferenceRequest = typeof PaymentTermReferenceRequestSchema.Type;

export const UsablePaymentTermReferenceSchema = Schema.Struct({
  definition: PaymentTermDefinitionSchema,
  kind: Schema.Literal('USABLE'),
  requestedPaymentTermRef: PaymentTermRefSchema,
});

export const RetiredPaymentTermReferenceSchema = Schema.Struct({
  definition: PaymentTermDefinitionSchema,
  kind: Schema.Literal('RETIRED'),
  requestedPaymentTermRef: PaymentTermRefSchema,
});

export const MissingPaymentTermReferenceSchema = Schema.Struct({
  kind: Schema.Literal('MISSING'),
  requestedPaymentTermRef: PaymentTermRefSchema,
});

export const IncompatiblePaymentTermReferenceSchema = Schema.Struct({
  actualCompatibilityId: PaymentTermCompatibilityIdSchema,
  actualConsumerCompatibility: Schema.Array(PaymentTermConsumerCompatibilitySchema),
  actualSemanticRevisionId: PaymentTermRevisionIdSchema,
  definition: PaymentTermDefinitionSchema,
  expectedCompatibilityId: Schema.optionalKey(PaymentTermCompatibilityIdSchema),
  expectedConsumerCompatibility: Schema.optionalKey(PaymentTermConsumerCompatibilitySchema),
  expectedSemanticRevisionId: Schema.optionalKey(PaymentTermRevisionIdSchema),
  kind: Schema.Literal('INCOMPATIBLE'),
  requestedPaymentTermRef: PaymentTermRefSchema,
});

export const BrokenPaymentTermReferenceSchema = Schema.Struct({
  kind: Schema.Literal('BROKEN'),
  reason: Schema.String,
  requestedPaymentTermRef: PaymentTermRefSchema,
});

export const PaymentTermReferenceResolutionSchema = Schema.Union([
  UsablePaymentTermReferenceSchema,
  RetiredPaymentTermReferenceSchema,
  MissingPaymentTermReferenceSchema,
  IncompatiblePaymentTermReferenceSchema,
  BrokenPaymentTermReferenceSchema,
]);
export type PaymentTermReferenceResolution = typeof PaymentTermReferenceResolutionSchema.Type;
