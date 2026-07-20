import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';

export const taskRetentionStateSchema = Schema.Literals(['active', 'archived', 'softDeleted']);

export const transitionTaskRetentionActionKey = 'ticketing.transitionTaskRetention' as const;

export const transitionTaskRetentionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  taskId: Schema.String,
  transition: Schema.Literals(['archive', 'restore', 'softDelete', 'hardDelete']),
});

export const transitionTaskRetentionActionHeadersSchema = idempotentActionHeadersSchema;

export const retainedTaskTransitionResponseSchema = Schema.Struct({
  retentionState: taskRetentionStateSchema,
  taskId: Schema.String,
  taskRevision: Schema.Finite,
});

export const hardDeletedTaskTransitionResponseSchema = Schema.Struct({
  hardDeletedTaskId: Schema.String,
  retentionState: Schema.Literal('hardDeleted'),
});

export const transitionTaskRetentionActionResponseSchema = Schema.Union([
  retainedTaskTransitionResponseSchema,
  hardDeletedTaskTransitionResponseSchema,
]);

export const transitionTaskRetentionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: transitionTaskRetentionActionResponseSchema,
});

export const transitionTaskRetentionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const transitionTaskRetentionActionFailureSchema = coreSdkOperationFailureSchema;

export type TaskRetentionState = typeof taskRetentionStateSchema.Type;
export type TransitionTaskRetentionActionPayload =
  typeof transitionTaskRetentionActionPayloadSchema.Type;
export type TransitionTaskRetentionActionResponse =
  typeof transitionTaskRetentionActionResponseSchema.Type;
export type TransitionTaskRetentionActionOutcome =
  typeof transitionTaskRetentionActionOutcomeSchema.Type;
export type TransitionTaskRetentionActionFailure =
  typeof transitionTaskRetentionActionFailureSchema.Type;

export const transitionTaskRetentionActionTitle = 'Transition Task Retention' as const;
