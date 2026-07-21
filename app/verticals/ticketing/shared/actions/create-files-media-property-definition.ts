import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';
import { filesMediaPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createFilesMediaPropertyDefinitionActionKey =
  'ticketing.createFilesMediaPropertyDefinition' as const;

export const createFilesMediaPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});

export const createFilesMediaPropertyDefinitionActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const createFilesMediaPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: filesMediaPropertyDefinitionSchema,
});

export const createFilesMediaPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createFilesMediaPropertyDefinitionActionResponseSchema,
});

const failureFields = {
  code: Schema.optional(Schema.String),
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
  state: Schema.optional(Schema.Json),
};

const failure = <const TErrorTags extends readonly string[]>(
  errorTags: TErrorTags,
  httpStatus: number,
) =>
  Schema.Struct({ ...failureFields, errorTag: Schema.Literals(errorTags) }).pipe(
    HttpApiSchema.status(httpStatus),
  );

export const createFilesMediaPropertyDefinitionActionFailureSchemas = [
  failure(['OperationAuthRequired', 'OperationContextInvalid'], 401),
  failure(['OperationAuthorizationDenied', 'OperationModuleStateDenied'], 403),
  failure(['OperationIdempotencyKeyRequired'], 428),
  failure(
    [
      'OperationDomainRejected',
      'OperationIdempotencyConflict',
      'OperationIdempotencyReplayUnavailable',
      'OperationPolicyDenied',
    ],
    409,
  ),
  failure(['OperationExecutionFailed', 'OperationPersistenceFailed'], 500),
] as const;

export const createFilesMediaPropertyDefinitionActionFailureSchema = Schema.Union(
  createFilesMediaPropertyDefinitionActionFailureSchemas,
);

export type CreateFilesMediaPropertyDefinitionActionPayload =
  typeof createFilesMediaPropertyDefinitionActionPayloadSchema.Type;
export type CreateFilesMediaPropertyDefinitionActionResponse =
  typeof createFilesMediaPropertyDefinitionActionResponseSchema.Type;
export type CreateFilesMediaPropertyDefinitionActionOutcome =
  typeof createFilesMediaPropertyDefinitionActionOutcomeSchema.Type;
export type CreateFilesMediaPropertyDefinitionActionFailure =
  typeof createFilesMediaPropertyDefinitionActionFailureSchema.Type;
