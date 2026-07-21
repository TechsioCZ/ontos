import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';

export const deleteSelectOptionActionKey = 'ticketing.deleteSelectOption' as const;

export const deleteSelectOptionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  confirmed: Schema.Boolean,
  expectedDefinitionRevision: Schema.Finite,
  expectedImpactCount: Schema.Finite,
  expectedOptionRevision: Schema.Finite,
  optionId: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const deleteSelectOptionActionHeadersSchema = idempotentActionHeadersSchema;

export const deleteSelectOptionActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  deletedOptionId: Schema.String,
  impactCount: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export const deleteSelectOptionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: deleteSelectOptionActionResponseSchema,
});

export const deleteSelectOptionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const deleteSelectOptionActionFailureSchema = coreSdkOperationFailureSchema;

export type DeleteSelectOptionActionPayload = typeof deleteSelectOptionActionPayloadSchema.Type;
export type DeleteSelectOptionActionResponse = typeof deleteSelectOptionActionResponseSchema.Type;
export type DeleteSelectOptionActionOutcome = typeof deleteSelectOptionActionOutcomeSchema.Type;
export type DeleteSelectOptionActionFailure = typeof deleteSelectOptionActionFailureSchema.Type;

export const deleteSelectOptionActionTitle = 'Delete Select Option' as const;
