import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

const httpStatusAnnotation = Symbol.for('@effect/platform/HttpApiSchema/AnnotationStatus');

const httpStatus =
  (status: number) =>
  <TSchema extends { annotate: (annotations: Record<symbol, unknown>) => TSchema }>(
    schema: TSchema,
  ): TSchema =>
    schema.annotate({ [httpStatusAnnotation]: status }) as TSchema;

export const accountingMarkerSchema = Schema.Struct({
  appId: Schema.String,
  build: Schema.String,
  deployProfile: Schema.String,
  packageName: Schema.String,
  surface: Schema.String,
  version: Schema.String,
});

export const accountingItemSchema = Schema.Struct({
  id: Schema.String,
  marker: accountingMarkerSchema,
  title: Schema.String,
});

export type AccountingItem = typeof accountingItemSchema.Type;

export const accountingReadinessSchema = Schema.Struct({
  checks: Schema.Struct({
    effectBff: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: accountingMarkerSchema,
  status: Schema.Literal('ready'),
  versionSkew: Schema.Literal('none'),
});

export const accountingListPayloadSchema = Schema.Struct({
  limit: Schema.optional(Schema.FiniteFromString),
});

export const accountingListResultSchema = Schema.Struct({
  items: Schema.Array(accountingItemSchema),
});

const taggedMessageSchema = <const TTag extends string>(tag: TTag, status: number) =>
  Schema.TaggedStruct(tag, {
    message: Schema.String,
  }).pipe(httpStatus(status));

const taggedMessage = <const TTag extends string>(tag: TTag, message: string) => ({
  _tag: tag,
  message,
});

export const operationContextAuthRequiredSchema = taggedMessageSchema(
  'OperationContextAuthRequired',
  401,
);

export type OperationContextAuthRequired = typeof operationContextAuthRequiredSchema.Type;

export const createOperationContextAuthRequired = (message: string): OperationContextAuthRequired =>
  taggedMessage('OperationContextAuthRequired', message);

export const operationIdempotencyKeyRequiredSchema = taggedMessageSchema(
  'OperationIdempotencyKeyRequired',
  428,
);

export type OperationIdempotencyKeyRequired = typeof operationIdempotencyKeyRequiredSchema.Type;

export const createOperationIdempotencyKeyRequired = (
  message: string,
): OperationIdempotencyKeyRequired => taggedMessage('OperationIdempotencyKeyRequired', message);

export const operationIdempotencyConflictSchema = taggedMessageSchema(
  'OperationIdempotencyConflict',
  409,
);

export type OperationIdempotencyConflict = typeof operationIdempotencyConflictSchema.Type;

export const createOperationIdempotencyConflict = (message: string): OperationIdempotencyConflict =>
  taggedMessage('OperationIdempotencyConflict', message);

export const operationIdempotencyReplayUnavailableSchema = taggedMessageSchema(
  'OperationIdempotencyReplayUnavailable',
  409,
);

export type OperationIdempotencyReplayUnavailable =
  typeof operationIdempotencyReplayUnavailableSchema.Type;

export const createOperationIdempotencyReplayUnavailable = (
  message: string,
): OperationIdempotencyReplayUnavailable =>
  taggedMessage('OperationIdempotencyReplayUnavailable', message);

export const operationPersistenceFailedSchema = taggedMessageSchema(
  'OperationPersistenceFailed',
  500,
);

export type OperationPersistenceFailed = typeof operationPersistenceFailedSchema.Type;

export const createOperationPersistenceFailed = (message: string): OperationPersistenceFailed =>
  taggedMessage('OperationPersistenceFailed', message);

export const operationDomainRejectedSchema = Schema.TaggedStruct('OperationDomainRejected', {
  code: Schema.String,
  message: Schema.String,
}).pipe(httpStatus(409));

export type OperationDomainRejected = typeof operationDomainRejectedSchema.Type;

export const createOperationDomainRejected = ({
  code,
  message,
}: {
  readonly code: string;
  readonly message: string;
}): OperationDomainRejected => ({
  _tag: 'OperationDomainRejected',
  code,
  message,
});

export const operationPolicyDeniedSchema = Schema.TaggedStruct('OperationPolicyDenied', {
  code: Schema.String,
  message: Schema.String,
  policyKey: Schema.String,
}).pipe(httpStatus(409));

export type OperationPolicyDenied = typeof operationPolicyDeniedSchema.Type;

export const createOperationPolicyDenied = ({
  code,
  message,
  policyKey,
}: {
  readonly code: string;
  readonly message: string;
  readonly policyKey: string;
}): OperationPolicyDenied => ({
  _tag: 'OperationPolicyDenied',
  code,
  message,
  policyKey,
});

export const operationAuthorizationDeniedSchema = Schema.TaggedStruct(
  'OperationAuthorizationDenied',
  {
    code: Schema.String,
    message: Schema.String,
    permission: Schema.String,
    provider: Schema.Literal('spicedb'),
    resourceObjectId: Schema.String,
    resourceObjectType: Schema.String,
  },
).pipe(httpStatus(403));

export type OperationAuthorizationDenied = typeof operationAuthorizationDeniedSchema.Type;

export const createOperationAuthorizationDenied = ({
  code,
  message,
  permission,
  provider,
  resourceObjectId,
  resourceObjectType,
}: {
  readonly code: string;
  readonly message: string;
  readonly permission: string;
  readonly provider: 'spicedb';
  readonly resourceObjectId: string;
  readonly resourceObjectType: string;
}): OperationAuthorizationDenied => ({
  _tag: 'OperationAuthorizationDenied',
  code,
  message,
  permission,
  provider,
  resourceObjectId,
  resourceObjectType,
});

export const operationModuleStateDeniedSchema = Schema.TaggedStruct('OperationModuleStateDenied', {
  accessKind: Schema.Union([
    Schema.Literal('load'),
    Schema.Literal('read'),
    Schema.Literal('mutate'),
  ]),
  code: Schema.String,
  message: Schema.String,
  moduleKey: Schema.String,
  state: Schema.String,
}).pipe(httpStatus(403));

export type OperationModuleStateDenied = typeof operationModuleStateDeniedSchema.Type;

export const createOperationModuleStateDenied = ({
  accessKind,
  code,
  message,
  moduleKey,
  state,
}: {
  readonly accessKind: 'load' | 'read' | 'mutate';
  readonly code: string;
  readonly message: string;
  readonly moduleKey: string;
  readonly state: string;
}): OperationModuleStateDenied => ({
  _tag: 'OperationModuleStateDenied',
  accessKind,
  code,
  message,
  moduleKey,
  state,
});

export const operationExecutionFailedSchema = taggedMessageSchema('OperationExecutionFailed', 500);

export type OperationExecutionFailed = typeof operationExecutionFailedSchema.Type;

export const createOperationExecutionFailed = (message: string): OperationExecutionFailed =>
  taggedMessage('OperationExecutionFailed', message);

const operationErrorSchemas = [
  operationContextAuthRequiredSchema,
  operationIdempotencyKeyRequiredSchema,
  operationIdempotencyConflictSchema,
  operationIdempotencyReplayUnavailableSchema,
  operationPersistenceFailedSchema,
  operationDomainRejectedSchema,
  operationAuthorizationDeniedSchema,
  operationModuleStateDeniedSchema,
  operationPolicyDeniedSchema,
  operationExecutionFailedSchema,
] as const;

export const operationErrorSchema = Schema.Union(operationErrorSchemas);

export const accountingEffectApi = HttpApi.make('AccountingEffectApi').add(
  HttpApiGroup.make('accounting')
    .add(
      HttpApiEndpoint.get('list', '/effect/accounting', {
        error: operationErrorSchema,
        query: {
          limit: Schema.optional(Schema.FiniteFromString),
        },
        success: accountingListResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('readiness', '/effect/accounting/readiness', {
        success: accountingReadinessSchema,
      }),
    ),
);

export const accountingApiContract = {
  apiPrefix: '/accounting-api',
  basePath: '/accounting-api/effect/accounting',
  ownerId: 'accounting',
} as const;
