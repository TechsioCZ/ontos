import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';

export const deleteMultiSelectOptionActionKey = 'ticketing.deleteMultiSelectOption' as const;

export const deleteMultiSelectOptionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  confirmed: Schema.Boolean,
  expectedDefinitionRevision: Schema.Finite,
  expectedImpactCount: Schema.Finite,
  expectedImpactToken: Schema.String,
  expectedOptionRevision: Schema.Finite,
  optionId: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const deleteMultiSelectOptionActionHeadersSchema = idempotentActionHeadersSchema;

export const deleteMultiSelectOptionActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  deletedOptionId: Schema.String,
  impactCount: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export const deleteMultiSelectOptionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: deleteMultiSelectOptionActionResponseSchema,
});

export const deleteMultiSelectOptionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const deleteMultiSelectOptionActionFailureSchema = coreSdkOperationFailureSchema;

export type DeleteMultiSelectOptionActionPayload =
  typeof deleteMultiSelectOptionActionPayloadSchema.Type;
export type DeleteMultiSelectOptionActionResponse =
  typeof deleteMultiSelectOptionActionResponseSchema.Type;
export type DeleteMultiSelectOptionActionOutcome =
  typeof deleteMultiSelectOptionActionOutcomeSchema.Type;
export type DeleteMultiSelectOptionActionFailure =
  typeof deleteMultiSelectOptionActionFailureSchema.Type;

export const deleteMultiSelectOptionActionTitle = 'Delete Multi-select Option' as const;
