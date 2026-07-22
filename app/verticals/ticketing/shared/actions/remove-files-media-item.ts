import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';

export const removeFilesMediaItemActionKey = 'ticketing.removeFilesMediaItem' as const;

export const removeFilesMediaItemActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  itemId: Schema.String,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});

export const removeFilesMediaItemActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const removeFilesMediaItemActionResponseSchema = Schema.Struct({
  removedItemId: Schema.String,
  taskRevision: Schema.Finite,
});

export const removeFilesMediaItemActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: removeFilesMediaItemActionResponseSchema,
});

const removeFilesMediaItemActionFailureFields = {
  code: Schema.optional(Schema.String),
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
  state: Schema.optional(Schema.Json),
};

const removeFilesMediaItemActionFailure = <const TErrorTags extends readonly string[]>(
  errorTags: TErrorTags,
  httpStatus: number,
) =>
  Schema.Struct({
    ...removeFilesMediaItemActionFailureFields,
    errorTag: Schema.Literals(errorTags),
  }).pipe(HttpApiSchema.status(httpStatus));

export const removeFilesMediaItemActionFailureSchemas = [
  removeFilesMediaItemActionFailure(['OperationAuthRequired', 'OperationContextInvalid'], 401),
  removeFilesMediaItemActionFailure(
    ['OperationAuthorizationDenied', 'OperationModuleStateDenied'],
    403,
  ),
  removeFilesMediaItemActionFailure(['OperationIdempotencyKeyRequired'], 428),
  removeFilesMediaItemActionFailure(
    [
      'OperationDomainRejected',
      'OperationIdempotencyConflict',
      'OperationIdempotencyReplayUnavailable',
      'OperationPolicyDenied',
    ],
    409,
  ),
  removeFilesMediaItemActionFailure(
    ['OperationExecutionFailed', 'OperationPersistenceFailed'],
    500,
  ),
] as const;

export const removeFilesMediaItemActionFailureSchema = Schema.Union(
  removeFilesMediaItemActionFailureSchemas,
);

export type RemoveFilesMediaItemActionPayload = typeof removeFilesMediaItemActionPayloadSchema.Type;
export type RemoveFilesMediaItemActionResponse =
  typeof removeFilesMediaItemActionResponseSchema.Type;
export type RemoveFilesMediaItemActionOutcome = typeof removeFilesMediaItemActionOutcomeSchema.Type;
export type RemoveFilesMediaItemActionFailure = typeof removeFilesMediaItemActionFailureSchema.Type;

export const removeFilesMediaItemActionTitle = 'Remove Files & media item' as const;
