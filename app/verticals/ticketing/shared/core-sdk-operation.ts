import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';

const failureFields = {
  code: Schema.optional(Schema.String),
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
  state: Schema.optional(Schema.Json),
};

const failureSchema = <const TErrorTags extends readonly string[]>(
  errorTags: TErrorTags,
  httpStatus: number,
) =>
  Schema.Struct({
    ...failureFields,
    errorTag: Schema.Literals(errorTags),
  }).pipe(HttpApiSchema.status(httpStatus));

export const coreSdkOperationFailureSchema = Schema.Union([
  failureSchema(['OperationAuthRequired', 'OperationContextInvalid'], 401),
  failureSchema(['OperationAuthorizationDenied', 'OperationModuleStateDenied'], 403),
  failureSchema(['OperationIdempotencyKeyRequired'], 428),
  failureSchema(
    [
      'OperationDomainRejected',
      'OperationIdempotencyConflict',
      'OperationIdempotencyReplayUnavailable',
      'OperationPolicyDenied',
    ],
    409,
  ),
  failureSchema(['OperationExecutionFailed', 'OperationPersistenceFailed'], 500),
]);

export const operationContextHeadersSchema = Schema.Struct({
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const idempotentActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export type CoreSdkOperationFailure = typeof coreSdkOperationFailureSchema.Type;
