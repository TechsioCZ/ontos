import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';
import { externalFilesMediaItemSchema } from './upload-files-media-item.ts';

export const addFilesMediaExternalItemActionKey = 'ticketing.addFilesMediaExternalItem' as const;

export const addFilesMediaExternalItemActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
  url: Schema.String,
});

export const addFilesMediaExternalItemActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const addFilesMediaExternalItemActionResponseSchema = Schema.Struct({
  item: externalFilesMediaItemSchema,
  taskRevision: Schema.Finite,
});

export const addFilesMediaExternalItemActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: addFilesMediaExternalItemActionResponseSchema,
});

const addFilesMediaExternalItemActionFailureFields = {
  code: Schema.optional(Schema.String),
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
  state: Schema.optional(Schema.Json),
};

const addFilesMediaExternalItemActionFailure = <const TErrorTags extends readonly string[]>(
  errorTags: TErrorTags,
  httpStatus: number,
) =>
  Schema.Struct({
    ...addFilesMediaExternalItemActionFailureFields,
    errorTag: Schema.Literals(errorTags),
  }).pipe(HttpApiSchema.status(httpStatus));

export const addFilesMediaExternalItemActionFailureSchemas = [
  addFilesMediaExternalItemActionFailure(['OperationAuthRequired', 'OperationContextInvalid'], 401),
  addFilesMediaExternalItemActionFailure(
    ['OperationAuthorizationDenied', 'OperationModuleStateDenied'],
    403,
  ),
  addFilesMediaExternalItemActionFailure(['OperationIdempotencyKeyRequired'], 428),
  addFilesMediaExternalItemActionFailure(
    [
      'OperationDomainRejected',
      'OperationIdempotencyConflict',
      'OperationIdempotencyReplayUnavailable',
      'OperationPolicyDenied',
    ],
    409,
  ),
  addFilesMediaExternalItemActionFailure(
    ['OperationExecutionFailed', 'OperationPersistenceFailed'],
    500,
  ),
] as const;

export const addFilesMediaExternalItemActionFailureSchema = Schema.Union(
  addFilesMediaExternalItemActionFailureSchemas,
);

export type AddFilesMediaExternalItemActionPayload =
  typeof addFilesMediaExternalItemActionPayloadSchema.Type;
export type AddFilesMediaExternalItemActionResponse =
  typeof addFilesMediaExternalItemActionResponseSchema.Type;
export type AddFilesMediaExternalItemActionOutcome =
  typeof addFilesMediaExternalItemActionOutcomeSchema.Type;
export type AddFilesMediaExternalItemActionFailure =
  typeof addFilesMediaExternalItemActionFailureSchema.Type;

export const addFilesMediaExternalItemActionTitle = 'Add Files & media external item' as const;
