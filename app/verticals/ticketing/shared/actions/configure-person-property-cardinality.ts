import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { personPropertyDefinitionSchema } from '../task-property-definition.ts';

export const configurePersonPropertyCardinalityActionKey =
  'ticketing.configurePersonPropertyCardinality' as const;

export const configurePersonPropertyCardinalityActionPayloadSchema = Schema.Struct({
  cardinality: Schema.Literals(['one', 'unlimited']),
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export const configurePersonPropertyCardinalityActionHeadersSchema = idempotentActionHeadersSchema;

export const configurePersonPropertyCardinalityActionResponseSchema = Schema.Struct({
  definition: personPropertyDefinitionSchema,
});

export const configurePersonPropertyCardinalityActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: configurePersonPropertyCardinalityActionResponseSchema,
});

const cardinalityDomainFailureFields = {
  errorTag: Schema.Literal('OperationDomainRejected'),
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
};

export const configurePersonPropertyCardinalityConflictFailureSchema = Schema.Struct({
  ...cardinalityDomainFailureFields,
  code: Schema.Literal('ticketing.configurePersonPropertyCardinality.assignments_violate_limit'),
  state: Schema.Struct({ violatingTaskCount: Schema.Finite }),
}).pipe(HttpApiSchema.status(409));

const configurePersonPropertyCardinalityStaleFailureSchema = Schema.Struct({
  ...cardinalityDomainFailureFields,
  code: Schema.Literal('ticketing.configurePersonPropertyCardinality.stale_or_missing'),
}).pipe(HttpApiSchema.status(409));

const nonDomainConflictFailureSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  errorTag: Schema.Literals([
    'OperationIdempotencyConflict',
    'OperationIdempotencyReplayUnavailable',
    'OperationPolicyDenied',
  ]),
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
  state: Schema.optional(Schema.Json),
}).pipe(HttpApiSchema.status(409));

export const configurePersonPropertyCardinalityActionFailureSchemas = [
  coreSdkOperationFailureSchemas[0],
  coreSdkOperationFailureSchemas[1],
  coreSdkOperationFailureSchemas[2],
  configurePersonPropertyCardinalityConflictFailureSchema,
  configurePersonPropertyCardinalityStaleFailureSchema,
  nonDomainConflictFailureSchema,
  coreSdkOperationFailureSchemas[4],
] as const;
export const configurePersonPropertyCardinalityActionFailureSchema = Schema.Union(
  configurePersonPropertyCardinalityActionFailureSchemas,
);

export type ConfigurePersonPropertyCardinalityActionPayload =
  typeof configurePersonPropertyCardinalityActionPayloadSchema.Type;
export type ConfigurePersonPropertyCardinalityActionResponse =
  typeof configurePersonPropertyCardinalityActionResponseSchema.Type;
export type ConfigurePersonPropertyCardinalityActionOutcome =
  typeof configurePersonPropertyCardinalityActionOutcomeSchema.Type;
export type ConfigurePersonPropertyCardinalityActionFailure =
  typeof configurePersonPropertyCardinalityActionFailureSchema.Type;

export const configurePersonPropertyCardinalityActionTitle =
  'Configure Person Property Cardinality' as const;
