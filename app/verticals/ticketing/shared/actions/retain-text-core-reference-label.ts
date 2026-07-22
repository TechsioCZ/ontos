import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';
import { coreReferenceSchema } from '../core-reference.ts';

export const retainTextCoreReferenceLabelActionKey =
  'ticketing.retainTextCoreReferenceLabel' as const;

export const retainTextCoreReferenceLabelActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  propertyDefinitionId: Schema.String,
  reference: coreReferenceSchema,
  taskId: Schema.String,
});

export const retainTextCoreReferenceLabelActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const retainTextCoreReferenceLabelActionResponseSchema = Schema.Struct({
  changed: Schema.Boolean,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});

export const retainTextCoreReferenceLabelActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: retainTextCoreReferenceLabelActionResponseSchema,
});

const retainTextCoreReferenceLabelActionFailureFields = {
  code: Schema.optional(Schema.String),
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
  state: Schema.optional(Schema.Json),
};

const retainTextCoreReferenceLabelActionFailure = <const TErrorTags extends readonly string[]>(
  errorTags: TErrorTags,
  httpStatus: number,
) =>
  Schema.Struct({
    ...retainTextCoreReferenceLabelActionFailureFields,
    errorTag: Schema.Literals(errorTags),
  }).pipe(HttpApiSchema.status(httpStatus));

export const retainTextCoreReferenceLabelActionFailureSchemas = [
  retainTextCoreReferenceLabelActionFailure(
    ['OperationAuthRequired', 'OperationContextInvalid'],
    401,
  ),
  retainTextCoreReferenceLabelActionFailure(
    ['OperationAuthorizationDenied', 'OperationModuleStateDenied'],
    403,
  ),
  retainTextCoreReferenceLabelActionFailure(['OperationIdempotencyKeyRequired'], 428),
  retainTextCoreReferenceLabelActionFailure(
    [
      'OperationDomainRejected',
      'OperationIdempotencyConflict',
      'OperationIdempotencyReplayUnavailable',
      'OperationPolicyDenied',
    ],
    409,
  ),
  retainTextCoreReferenceLabelActionFailure(
    ['OperationExecutionFailed', 'OperationPersistenceFailed'],
    500,
  ),
] as const;

export const retainTextCoreReferenceLabelActionFailureSchema = Schema.Union(
  retainTextCoreReferenceLabelActionFailureSchemas,
);

export type RetainTextCoreReferenceLabelActionPayload =
  typeof retainTextCoreReferenceLabelActionPayloadSchema.Type;
export type RetainTextCoreReferenceLabelActionResponse =
  typeof retainTextCoreReferenceLabelActionResponseSchema.Type;
export type RetainTextCoreReferenceLabelActionOutcome =
  typeof retainTextCoreReferenceLabelActionOutcomeSchema.Type;
export type RetainTextCoreReferenceLabelActionFailure =
  typeof retainTextCoreReferenceLabelActionFailureSchema.Type;

export const retainTextCoreReferenceLabelActionTitle = 'Retain Text Core Reference Label' as const;
