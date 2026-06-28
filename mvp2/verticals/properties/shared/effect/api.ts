import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export const unitCreatePayloadSchema = Schema.String;

export const unitCreateResultSchema = Schema.Struct({
  status: Schema.Literal('ok'),
  unitId: Schema.String,
});

export const unitReadPayloadSchema = Schema.Struct({});

export const unitReadItemSchema = Schema.Struct({
  createdAt: Schema.String,
  name: Schema.String,
  unitId: Schema.String,
});

export const unitReadResultSchema = Schema.Array(unitReadItemSchema);

export const unitCreateHeadersSchema = Schema.Struct({
  'idempotency-key': Schema.optional(Schema.String),
});

const taggedMessageSchema = <const TTag extends string>(tag: TTag, status: number) =>
  Schema.TaggedStruct(tag, {
    message: Schema.String,
  }).pipe(HttpApiSchema.status(status));

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
}).pipe(HttpApiSchema.status(409));

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
}).pipe(HttpApiSchema.status(409));

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
).pipe(HttpApiSchema.status(403));

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
}).pipe(HttpApiSchema.status(403));

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

export const operationErrorSchema = Schema.Union([
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
]).pipe(HttpApiSchema.status(409));

export const propertiesEffectApi = HttpApi.make('PropertiesEffectApi').add(
  HttpApiGroup.make('properties')
    .add(
      HttpApiEndpoint.post('createUnit', '/effect/properties/unit', {
        error: operationErrorSchema,
        headers: unitCreateHeadersSchema,
        payload: unitCreatePayloadSchema,
        success: unitCreateResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('readUnits', '/effect/properties/units/read', {
        error: operationErrorSchema,
        success: unitReadResultSchema,
      }),
    ),
);

export const propertiesApiContract = {
  apiPrefix: '/properties-api',
  basePath: '/properties-api/effect/properties',
  ownerId: 'properties',
  readinessPath: '/properties-api/effect/properties/readiness',
} as const;
