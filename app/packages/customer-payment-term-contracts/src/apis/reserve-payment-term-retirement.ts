// Customer-owned public Action contract for staging Payment Term retirement.
import { PaymentTermMillisecondInstantSchema } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

const ReservationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PaymentTermRetirementReservationId'),
  Schema.decodeTo(Schema.String),
);
const PaymentTermResourceIdSchema = PaymentTermRefSchema.fields.resourceId;
const BoundedReasonSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());

export const PaymentTermRetirementReservationOperationSchema = Schema.Literals(['RESERVE', 'COMMIT', 'RELEASE']);
export type PaymentTermRetirementReservationOperation = typeof PaymentTermRetirementReservationOperationSchema.Type;

export const ReservePaymentTermRetirementPayloadSchema = Schema.Struct({
  effectiveAt: PaymentTermMillisecondInstantSchema,
  equivalentPaymentTermRefs: Schema.Array(PaymentTermRefSchema).check(Schema.isMaxLength(199)),
  operation: PaymentTermRetirementReservationOperationSchema,
  paymentTermRef: PaymentTermRefSchema,
  reason: BoundedReasonSchema,
  reservationRef: Schema.optionalKey(ReservationIdSchema),
});
export type ReservePaymentTermRetirementPayload = typeof ReservePaymentTermRetirementPayloadSchema.Type;

export const ReservePaymentTermRetirementResultSchema = Schema.Struct({
  effectiveAt: PaymentTermMillisecondInstantSchema,
  lifecycle: Schema.Literals(['RESERVED', 'COMMITTED', 'RELEASED']),
  paymentTermResourceIds: Schema.Array(PaymentTermResourceIdSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
  ),
  reservationRef: ReservationIdSchema,
});
export type ReservePaymentTermRetirementResult = typeof ReservePaymentTermRetirementResultSchema.Type;

export const ReservePaymentTermRetirementAuthenticationProblemSchema = makeProblemDetailsSchema(
  'ReservePaymentTermRetirementAuthenticationProblem',
  401,
);
export const ReservePaymentTermRetirementInvalidProblemSchema = makeProblemDetailsSchema(
  'ReservePaymentTermRetirementInvalidProblem',
  400,
);
export const ReservePaymentTermRetirementForbiddenProblemSchema = makeProblemDetailsSchema(
  'ReservePaymentTermRetirementForbiddenProblem',
  403,
);
export const ReservePaymentTermRetirementNotFoundProblemSchema = makeProblemDetailsSchema(
  'ReservePaymentTermRetirementNotFoundProblem',
  404,
);
export const ReservePaymentTermRetirementConflictProblemSchema = makeProblemDetailsSchema(
  'ReservePaymentTermRetirementConflictProblem',
  409,
);
export const ReservePaymentTermRetirementPolicyProblemSchema = makeProblemDetailsSchema(
  'ReservePaymentTermRetirementPolicyProblem',
  422,
);
export const ReservePaymentTermRetirementUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'ReservePaymentTermRetirementUnavailableProblem',
  503,
);
export const ReservePaymentTermRetirementInternalProblemSchema = makeProblemDetailsSchema(
  'ReservePaymentTermRetirementInternalProblem',
  500,
);
export const ReservePaymentTermRetirementApi = HttpApi.make('ReservePaymentTermRetirementApi').add(
  HttpApiGroup.make('reservePaymentTermRetirement').add(
    HttpApiEndpoint.post('execute', '/commerce-customer-context/actions/reserve-payment-term-retirement', {
      error: [
        ReservePaymentTermRetirementInvalidProblemSchema,
        ReservePaymentTermRetirementAuthenticationProblemSchema,
        ReservePaymentTermRetirementForbiddenProblemSchema,
        ReservePaymentTermRetirementNotFoundProblemSchema,
        ReservePaymentTermRetirementConflictProblemSchema,
        ReservePaymentTermRetirementPolicyProblemSchema,
        ReservePaymentTermRetirementUnavailableProblemSchema,
        ReservePaymentTermRetirementInternalProblemSchema,
      ],
      headers: {},
      params: {},
      payload: ReservePaymentTermRetirementPayloadSchema,
      query: {},
      success: ReservePaymentTermRetirementResultSchema,
    }),
  ),
);
