// Browser client of Pricing's price-schedule read (staff): the Current Revision and schedule revision a
// value-only revise-price needs as its expected Current. The endpoint mirrors pricing shared/apis/price-schedule.ts.
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Effect, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

import { PriceScheduleReadResultSchema } from '../domain/price-schedule.ts';
import { PriceRefSchema } from '../resources/price.ts';
import { operationGateway } from './action-gateway.ts';

export const PriceScheduleClientRequestSchema = Schema.Struct({ priceRef: PriceRefSchema });
export type PriceScheduleClientRequest = typeof PriceScheduleClientRequestSchema.Type;

const PriceScheduleClientResponseSchema = Schema.Union([
  PriceScheduleReadResultSchema,
  Schema.Struct({
    outcome: Schema.Literal('PRICE_SCHEDULE_UNAVAILABLE'),
    priceRef: PriceRefSchema,
    reason: Schema.String,
    retryable: Schema.Literal(true),
  }),
]);
export type PriceScheduleClientResponse = typeof PriceScheduleClientResponseSchema.Type;

const PriceScheduleClientApi = HttpApi.make('PriceScheduleClientApi').add(
  HttpApiGroup.make('priceSchedule').add(
    HttpApiEndpoint.post('execute', '/reads/price-schedule', {
      error: [
        makeProblemDetailsSchema('PriceScheduleInvalidProblem', 400),
        makeProblemDetailsSchema('PriceScheduleAuthenticationProblem', 401),
        makeProblemDetailsSchema('PriceScheduleForbiddenProblem', 403),
        makeProblemDetailsSchema('PriceScheduleNotFoundProblem', 404),
        makeProblemDetailsSchema('PriceSchedulePolicyConflictProblem', 409),
        makeProblemDetailsSchema('PriceSchedulePolicyProblem', 422),
        makeRetryableProblemDetailsSchema('PriceScheduleUnavailableProblem', 503),
        makeProblemDetailsSchema('PriceScheduleInternalProblem', 500),
      ],
      payload: PriceScheduleClientRequestSchema,
      success: PriceScheduleClientResponseSchema,
    }),
  ),
);

export const executePriceSchedule = (payload: PriceScheduleClientRequest, requestCorrelation: string) =>
  operationGateway.invoke((credential, { apiBaseUrl, compositionRevision }) =>
    makeGovernedEffectBffClient(
      {
        api: PriceScheduleClientApi,
        credential: Redacted.make(credential),
        defaultApiPrefix: '/pricing-api',
        requestCorrelation,
      },
      { baseUrl: apiBaseUrl, compositionRevision },
    ).pipe(Effect.flatMap((client) => client.priceSchedule.execute({ payload }))),
  );
