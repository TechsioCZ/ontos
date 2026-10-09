import type {
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { ReadHandlerUnavailable, defineScopedRoutine } from '@app/core-runtime';
import {
  MarketAffectedUseAssessmentResponseSchema,
  ReserveMarketRetirementPayloadSchema,
  ReserveMarketRetirementResultSchema,
} from '@app/customer-market-retirement-contracts';
import type {
  MarketAffectedUseAssessmentRequest,
  MarketAffectedUseAssessmentResponse,
  ReserveMarketRetirementPayload,
  ReserveMarketRetirementResult,
} from '@app/customer-market-retirement-contracts';
import { Context, Effect, Option, Schema } from 'effect';

const MODULE_KEY = 'commerce.customer-context' as const;
const ROUTINE_SCHEMA = 'commerce_customer_context' as const;
const RoutineResultSchema = Schema.Struct({ result: Schema.Json });
const MarketAffectedUseAssessmentResponseDecoder = Schema.make<Schema.Decoder<MarketAffectedUseAssessmentResponse>>(
  MarketAffectedUseAssessmentResponseSchema.ast,
);
const ReserveMarketRetirementPayloadCodec = Schema.make<
  Schema.Codec<ReserveMarketRetirementPayload, typeof ReserveMarketRetirementPayloadSchema.Encoded>
>(ReserveMarketRetirementPayloadSchema.ast);
const ReserveMarketRetirementResultDecoder = Schema.make<Schema.Decoder<ReserveMarketRetirementResult>>(
  ReserveMarketRetirementResultSchema.ast,
);
const assessParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'bigint' },
  { source: 'input', type: 'timestamptz' },
] as const;
const reserveParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
  { source: 'input', type: 'jsonb' },
] as const;

const assessMarketRetirementAffectedUseRoutine = defineScopedRoutine({
  name: 'assess_market_retirement_affected_use',
  ownerModuleKey: MODULE_KEY,
  parameters: assessParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'market-retirement.assess-affected-use',
  schema: ROUTINE_SCHEMA,
});

const reserveMarketRetirementRoutine = defineScopedRoutine({
  name: 'reserve_market_retirement',
  ownerModuleKey: MODULE_KEY,
  parameters: reserveParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'market-retirement.reserve',
  schema: ROUTINE_SCHEMA,
});

export const marketRetirementRoutineAllowlist = Object.freeze([
  assessMarketRetirementAffectedUseRoutine,
  reserveMarketRetirementRoutine,
]);

export interface MarketRetirementScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

export const MarketRetirementReservationConflictError = Schema.TaggedError<Error>()(
  'MarketRetirementReservationConflict',
  { reason: Schema.String },
);
export type MarketRetirementReservationConflict = InstanceType<typeof MarketRetirementReservationConflictError>;

export const MarketRetirementReservationInvalidRequestError = Schema.TaggedError<Error>()(
  'MarketRetirementReservationInvalidRequest',
  { reason: Schema.String },
);
export type MarketRetirementReservationInvalidRequest = InstanceType<
  typeof MarketRetirementReservationInvalidRequestError
>;

export const MarketRetirementReservationNotFoundError = Schema.TaggedError<Error>()(
  'MarketRetirementReservationNotFound',
  { reason: Schema.String },
);
export type MarketRetirementReservationNotFound = InstanceType<typeof MarketRetirementReservationNotFoundError>;

export const MarketRetirementReservationUnavailableError = Schema.TaggedError<Error>()(
  'MarketRetirementReservationUnavailable',
  { reason: Schema.String },
);
export type MarketRetirementReservationUnavailable = InstanceType<typeof MarketRetirementReservationUnavailableError>;

export type MarketRetirementReservationFailure =
  | MarketRetirementReservationConflict
  | MarketRetirementReservationInvalidRequest
  | MarketRetirementReservationNotFound
  | MarketRetirementReservationUnavailable;

const decodeJson = <Result, Failure>(
  rows: readonly { readonly result: Schema.Json }[],
  schema: Schema.Decoder<Result>,
  unavailable: (reason: string, cause?: unknown) => Failure,
): Effect.Effect<Result, Failure> => {
  const [row] = rows;
  return row === undefined
    ? Effect.fail(unavailable('Market retirement owner routine returned no result'))
    : Schema.decodeEffect(schema)(row.result).pipe(
        Effect.mapError((cause) => unavailable('Market retirement owner routine returned invalid evidence', cause)),
      );
};

export interface MarketAffectedUseAssessmentRepository {
  readonly assess: (
    input: MarketAffectedUseAssessmentRequest,
  ) => Effect.Effect<MarketAffectedUseAssessmentResponse, ReadHandlerUnavailable>;
}

class MarketAffectedUseAssessmentRepositoryService extends Context.Service<
  MarketAffectedUseAssessmentRepositoryService,
  MarketAffectedUseAssessmentRepository
>()(
  '@app/commerce-customer-context/persistence/market-retirement-persistence/MarketAffectedUseAssessmentRepositoryService',
) {}

const unavailableAffectedUse = (reason: string, cause?: unknown): ReadHandlerUnavailable => {
  const failure = new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

export const marketAffectedUseAssessmentRepositoryForInvoker = (
  invoker: MarketRetirementScopedRoutineInvoker,
): MarketAffectedUseAssessmentRepository =>
  MarketAffectedUseAssessmentRepositoryService.of({
    assess: (input) =>
      invoker
        .invoke(assessMarketRetirementAffectedUseRoutine, [
          input.marketRef.resourceId,
          BigInt(input.marketRevision),
          input.evaluatedAt,
        ])
        .pipe(
          Effect.mapError((cause) => unavailableAffectedUse('Market affected-use evidence is unavailable', cause)),
          Effect.flatMap((rows) =>
            decodeJson(rows, MarketAffectedUseAssessmentResponseDecoder, unavailableAffectedUse),
          ),
          Effect.withSpan('commerce.customer-context.market-retirement.assess-affected-use'),
        ),
  });

const JsonValueSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Finite,
    Schema.Boolean,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
);
const JsonObjectSchema = Schema.Record(Schema.String, JsonValueSchema);

const withCause = <Failure extends object>(failure: Failure, cause?: unknown): Failure => {
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const mapReservationFailure = (failure: ScopedRoutineInvocationError): MarketRetirementReservationFailure => {
  const constraint = Option.getOrUndefined(failure.constraint);
  if (constraint === 'market_retirement_reservation_conflict') {
    return new MarketRetirementReservationConflictError({
      reason: 'Market affected-use evidence changed or another retirement reservation is active',
    });
  }
  if (constraint === 'market_retirement_reservation_not_found') {
    return new MarketRetirementReservationNotFoundError({ reason: 'Market retirement reservation was not found' });
  }
  if (constraint === 'market_retirement_reservation_invalid') {
    return new MarketRetirementReservationInvalidRequestError({
      reason: 'Market retirement reservation request is invalid',
    });
  }
  return new MarketRetirementReservationUnavailableError({
    reason: 'Market retirement reservation persistence failed',
  });
};

interface MarketRetirementReservationOperations {
  readonly execute: (
    payload: ReserveMarketRetirementPayload,
    attribution: Readonly<{ readonly actionInvocationId: string; readonly actorPrincipalId: string }>,
  ) => Effect.Effect<ReserveMarketRetirementResult, MarketRetirementReservationFailure>;
}

export const marketRetirementReservationForTransaction = (
  invoker: MarketRetirementScopedRoutineInvoker,
): MarketRetirementReservationOperations => ({
  execute: (payload, attribution) =>
    Schema.encodeEffect(ReserveMarketRetirementPayloadCodec)(payload).pipe(
      Effect.mapError((cause) =>
        withCause(
          new MarketRetirementReservationInvalidRequestError({
            reason: 'Market retirement reservation input is invalid',
          }),
          cause,
        ),
      ),
      Effect.flatMap((encodedPayload) =>
        Schema.decodeEffect(JsonObjectSchema)({ ...encodedPayload, ...attribution }).pipe(
          Effect.mapError((cause) =>
            withCause(
              new MarketRetirementReservationInvalidRequestError({
                reason: 'Market retirement reservation input is invalid',
              }),
              cause,
            ),
          ),
        ),
      ),
      Effect.flatMap((encoded) =>
        invoker.invoke(reserveMarketRetirementRoutine, [encoded]).pipe(Effect.mapError(mapReservationFailure)),
      ),
      Effect.flatMap((rows) =>
        decodeJson(rows, ReserveMarketRetirementResultDecoder, (reason, cause) =>
          withCause(new MarketRetirementReservationUnavailableError({ reason }), cause),
        ),
      ),
      Effect.withSpan('commerce.customer-context.market-retirement.reserve'),
    ),
});
