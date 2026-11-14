import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import {
  EmailDeliveriesResponseSchema,
  EmailDeliveryViewSchema,
  EmailProviderViewSchema,
} from './dispatcher/contract.ts';

export {
  EmailDeliveryEventSchema,
  EmailDeliverySourceSchema,
  EmailDeliveryStatusSchema,
  EmailProviderViewSchema,
  emailEventLabels,
  emailStatusLabels,
} from './dispatcher/contract.ts';

/** Acceptance receipts contain no recipient, message content or provider identifier. */
export const EmailDeliveryReceiptSchema = EmailDeliveryViewSchema;
export type EmailDeliveryReceipt = typeof EmailDeliveryReceiptSchema.Type;

export const EmailDeliveryReceiptsResponseSchema = EmailDeliveriesResponseSchema;
export type EmailDeliveryReceiptsResponse = typeof EmailDeliveryReceiptsResponseSchema.Type;

// The endpoint validates selector combinations before authentication or any database acquisition.
// Single and repeated query values retain the existing URL protocol and invalid-query category.
const QueryValueSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const SubjectQuerySchema = Schema.Union([
  EmailDeliveryViewSchema.fields.subjectId,
  Schema.Array(EmailDeliveryViewSchema.fields.subjectId),
]);
export const EmailDeliveryReceiptsQuerySchema = Schema.Struct({
  recipient: Schema.optionalKey(Schema.RedactedFromValue(QueryValueSchema)),
  source: Schema.optionalKey(QueryValueSchema),
  subjectId: Schema.optionalKey(SubjectQuerySchema),
  subjectNumber: Schema.optionalKey(QueryValueSchema),
});
export type EmailDeliveryReceiptsQuery = typeof EmailDeliveryReceiptsQuerySchema.Encoded;

export const EmailReceiptsInvalidProblemSchema = makeProblemDetailsSchema('EmailReceiptsInvalidProblem', 400, {
  error: Schema.Literal('invalid_query'),
});
export const EmailReceiptsAuthenticationProblemSchema = makeProblemDetailsSchema(
  'EmailReceiptsAuthenticationProblem',
  401,
  { error: Schema.Literal('authentication_required') },
);
export const EmailReceiptsForbiddenProblemSchema = makeProblemDetailsSchema('EmailReceiptsForbiddenProblem', 403, {
  error: Schema.Literal('forbidden'),
});
export const EmailReceiptsUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'EmailReceiptsUnavailableProblem',
  503,
  { error: Schema.Literal('email_unavailable') },
);
export const EmailReceiptsProblemSchema = Schema.Union([
  EmailReceiptsInvalidProblemSchema,
  EmailReceiptsAuthenticationProblemSchema,
  EmailReceiptsForbiddenProblemSchema,
  EmailReceiptsUnavailableProblemSchema,
]);
export type EmailReceiptsProblem = typeof EmailReceiptsProblemSchema.Type;

export const EmailReceiptsApi = HttpApi.make('EmailReceiptsApi').add(
  HttpApiGroup.make('emailReceipts')
    .add(
      HttpApiEndpoint.get('list', '/email/deliveries', {
        error: [
          EmailReceiptsInvalidProblemSchema,
          EmailReceiptsAuthenticationProblemSchema,
          EmailReceiptsForbiddenProblemSchema,
          EmailReceiptsUnavailableProblemSchema,
        ],
        query: EmailDeliveryReceiptsQuerySchema,
        success: EmailDeliveryReceiptsResponseSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('provider', '/email/provider', {
        error: [EmailReceiptsUnavailableProblemSchema],
        success: EmailProviderViewSchema,
      }),
    ),
);
