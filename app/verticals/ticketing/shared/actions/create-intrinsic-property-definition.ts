import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { intrinsicPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createIntrinsicPropertyDefinitionActionKey =
  'ticketing.createIntrinsicPropertyDefinition' as const;

export const createIntrinsicPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  datatype: Schema.Literals(['created_time', 'created_by', 'last_edited_time', 'last_edited_by']),
  mandatory: Schema.Boolean,
  name: Schema.String,
});

export const createIntrinsicPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const createIntrinsicPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: intrinsicPropertyDefinitionSchema,
});

export const createIntrinsicPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createIntrinsicPropertyDefinitionActionResponseSchema,
});

export const createIntrinsicPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createIntrinsicPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type CreateIntrinsicPropertyDefinitionActionPayload =
  typeof createIntrinsicPropertyDefinitionActionPayloadSchema.Type;
export type CreateIntrinsicPropertyDefinitionActionResponse =
  typeof createIntrinsicPropertyDefinitionActionResponseSchema.Type;
export type CreateIntrinsicPropertyDefinitionActionOutcome =
  typeof createIntrinsicPropertyDefinitionActionOutcomeSchema.Type;
export type CreateIntrinsicPropertyDefinitionActionFailure =
  typeof createIntrinsicPropertyDefinitionActionFailureSchema.Type;

export const createIntrinsicPropertyDefinitionActionTitle =
  'Create Intrinsic Task Property Definition' as const;
