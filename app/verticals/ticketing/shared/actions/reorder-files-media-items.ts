import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';

export const reorderFilesMediaItemsActionKey = 'ticketing.reorderFilesMediaItems' as const;

export const reorderFilesMediaItemsActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  itemIds: Schema.Array(Schema.String),
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});

export const reorderFilesMediaItemsActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const reorderFilesMediaItemsActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
});

export const reorderFilesMediaItemsActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: reorderFilesMediaItemsActionResponseSchema,
});

const reorderFilesMediaItemsActionFailureFields = {
  code: Schema.optional(Schema.String),
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
  state: Schema.optional(Schema.Json),
};

const reorderFilesMediaItemsActionFailure = <const TErrorTags extends readonly string[]>(
  errorTags: TErrorTags,
  httpStatus: number,
) =>
  Schema.Struct({
    ...reorderFilesMediaItemsActionFailureFields,
    errorTag: Schema.Literals(errorTags),
  }).pipe(HttpApiSchema.status(httpStatus));

export const reorderFilesMediaItemsActionFailureSchemas = [
  reorderFilesMediaItemsActionFailure(['OperationAuthRequired', 'OperationContextInvalid'], 401),
  reorderFilesMediaItemsActionFailure(
    ['OperationAuthorizationDenied', 'OperationModuleStateDenied'],
    403,
  ),
  reorderFilesMediaItemsActionFailure(['OperationIdempotencyKeyRequired'], 428),
  reorderFilesMediaItemsActionFailure(
    [
      'OperationDomainRejected',
      'OperationIdempotencyConflict',
      'OperationIdempotencyReplayUnavailable',
      'OperationPolicyDenied',
    ],
    409,
  ),
  reorderFilesMediaItemsActionFailure(
    ['OperationExecutionFailed', 'OperationPersistenceFailed'],
    500,
  ),
] as const;

export const reorderFilesMediaItemsActionFailureSchema = Schema.Union(
  reorderFilesMediaItemsActionFailureSchemas,
);

export type ReorderFilesMediaItemsActionPayload =
  typeof reorderFilesMediaItemsActionPayloadSchema.Type;
export type ReorderFilesMediaItemsActionResponse =
  typeof reorderFilesMediaItemsActionResponseSchema.Type;
export type ReorderFilesMediaItemsActionOutcome =
  typeof reorderFilesMediaItemsActionOutcomeSchema.Type;
export type ReorderFilesMediaItemsActionFailure =
  typeof reorderFilesMediaItemsActionFailureSchema.Type;

export const reorderFilesMediaItemsActionTitle = 'Reorder Files & media items' as const;
