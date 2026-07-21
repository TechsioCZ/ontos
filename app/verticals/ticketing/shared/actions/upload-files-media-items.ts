import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';
import { filesMediaItemSchema } from './upload-files-media-item.ts';

export const uploadFilesMediaItemsActionKey = 'ticketing.uploadFilesMediaItems' as const;

export const filesMediaUploadSchema = Schema.Struct({
  bytesBase64: Schema.String,
  clientMimeType: Schema.optional(Schema.String),
  filename: Schema.String,
});

export const uploadFilesMediaItemsActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  files: Schema.Array(filesMediaUploadSchema),
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});

export const uploadFilesMediaItemsActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const filesMediaUploadOutcomeSchema = Schema.Union([
  Schema.Struct({
    item: filesMediaItemSchema,
    ok: Schema.Literal(true),
  }),
  Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    ok: Schema.Literal(false),
  }),
]);

export const uploadFilesMediaItemsActionResponseSchema = Schema.Struct({
  outcomes: Schema.Array(filesMediaUploadOutcomeSchema),
  taskRevision: Schema.Finite,
});

export const uploadFilesMediaItemsActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: uploadFilesMediaItemsActionResponseSchema,
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

export const uploadFilesMediaItemsActionFailureSchemas = [
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

export const uploadFilesMediaItemsActionFailureSchema = Schema.Union(
  uploadFilesMediaItemsActionFailureSchemas,
);

export type FilesMediaUpload = typeof filesMediaUploadSchema.Type;
export type FilesMediaUploadOutcome = typeof filesMediaUploadOutcomeSchema.Type;
export type UploadFilesMediaItemsActionPayload =
  typeof uploadFilesMediaItemsActionPayloadSchema.Type;
export type UploadFilesMediaItemsActionResponse =
  typeof uploadFilesMediaItemsActionResponseSchema.Type;
export type UploadFilesMediaItemsActionOutcome =
  typeof uploadFilesMediaItemsActionOutcomeSchema.Type;
export type UploadFilesMediaItemsActionFailure =
  typeof uploadFilesMediaItemsActionFailureSchema.Type;
