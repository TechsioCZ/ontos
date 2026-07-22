import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';

export const uploadFilesMediaItemActionKey = 'ticketing.uploadFilesMediaItem' as const;

export const uploadFilesMediaItemActionPayloadSchema = Schema.Struct({
  bytesBase64: Schema.String,
  clientMimeType: Schema.optional(Schema.String),
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  filename: Schema.String,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});

export const uploadFilesMediaItemActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const uploadedFilesMediaItemSchema = Schema.Struct({
  access: Schema.Literal('download'),
  byteSize: Schema.Finite,
  displayFilename: Schema.String,
  effectiveMimeType: Schema.String,
  itemId: Schema.String,
  mediaAssetId: Schema.String,
  position: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export const externalFilesMediaItemSchema = Schema.Struct({
  access: Schema.Literal('external'),
  externalUrl: Schema.String,
  itemId: Schema.String,
  position: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export const filesMediaItemSchema = Schema.Union([
  uploadedFilesMediaItemSchema,
  externalFilesMediaItemSchema,
]);

export const uploadFilesMediaItemActionResponseSchema = Schema.Struct({
  item: filesMediaItemSchema,
  taskRevision: Schema.Finite,
});

export const uploadFilesMediaItemActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: uploadFilesMediaItemActionResponseSchema,
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

export const uploadFilesMediaItemActionFailureSchemas = [
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

export const uploadFilesMediaItemActionFailureSchema = Schema.Union(
  uploadFilesMediaItemActionFailureSchemas,
);

export type FilesMediaItem = typeof filesMediaItemSchema.Type;
export type UploadFilesMediaItemActionPayload = typeof uploadFilesMediaItemActionPayloadSchema.Type;
export type UploadFilesMediaItemActionResponse =
  typeof uploadFilesMediaItemActionResponseSchema.Type;
export type UploadFilesMediaItemActionOutcome = typeof uploadFilesMediaItemActionOutcomeSchema.Type;
export type UploadFilesMediaItemActionFailure = typeof uploadFilesMediaItemActionFailureSchema.Type;
