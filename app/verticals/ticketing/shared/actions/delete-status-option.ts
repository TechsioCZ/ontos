import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';

export const deleteStatusOptionActionKey = 'ticketing.deleteStatusOption' as const;

export const deleteStatusOptionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  confirmed: Schema.Boolean,
  expectedDefinitionRevision: Schema.Finite,
  expectedImpactCount: Schema.Finite,
  expectedImpactToken: Schema.String,
  expectedOptionRevision: Schema.Finite,
  optionId: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const deleteStatusOptionActionHeadersSchema = idempotentActionHeadersSchema;

export const deleteStatusOptionActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  deletedOptionId: Schema.String,
  impactCount: Schema.Finite,
  propertyDefinitionId: Schema.String,
  replacementOptionId: Schema.String,
});

export const deleteStatusOptionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: deleteStatusOptionActionResponseSchema,
});

export const deleteStatusOptionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const deleteStatusOptionActionFailureSchema = coreSdkOperationFailureSchema;

export type DeleteStatusOptionActionPayload = typeof deleteStatusOptionActionPayloadSchema.Type;
export type DeleteStatusOptionActionResponse = typeof deleteStatusOptionActionResponseSchema.Type;
export type DeleteStatusOptionActionOutcome = typeof deleteStatusOptionActionOutcomeSchema.Type;
export type DeleteStatusOptionActionFailure = typeof deleteStatusOptionActionFailureSchema.Type;

export const deleteStatusOptionActionTitle = 'Delete Status Option' as const;
