import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import {
  selectOptionOrderModeSchema,
  selectPropertyDefinitionSchema,
} from '../task-property-definition.ts';

export const configureSelectOptionOrderActionKey = 'ticketing.configureSelectOptionOrder' as const;
export const configureSelectOptionOrderActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  manualOptionIds: Schema.optional(Schema.Array(Schema.String)),
  optionOrderMode: selectOptionOrderModeSchema,
  propertyDefinitionId: Schema.String,
  viewerLocale: Schema.String,
});
export const configureSelectOptionOrderActionHeadersSchema = idempotentActionHeadersSchema;
export const configureSelectOptionOrderActionResponseSchema = Schema.Struct({
  definition: selectPropertyDefinitionSchema,
});
export const configureSelectOptionOrderActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: configureSelectOptionOrderActionResponseSchema,
});
export const configureSelectOptionOrderActionFailureSchemas = coreSdkOperationFailureSchemas;
export const configureSelectOptionOrderActionFailureSchema = coreSdkOperationFailureSchema;
export type ConfigureSelectOptionOrderActionPayload =
  typeof configureSelectOptionOrderActionPayloadSchema.Type;
export type ConfigureSelectOptionOrderActionResponse =
  typeof configureSelectOptionOrderActionResponseSchema.Type;
export type ConfigureSelectOptionOrderActionOutcome =
  typeof configureSelectOptionOrderActionOutcomeSchema.Type;
export type ConfigureSelectOptionOrderActionFailure =
  typeof configureSelectOptionOrderActionFailureSchema.Type;
export const configureSelectOptionOrderActionTitle = 'Configure Select Option Order' as const;
