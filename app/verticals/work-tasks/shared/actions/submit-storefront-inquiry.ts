import { Schema, Struct } from 'effect';
import { StorefrontInquirySchema, StorefrontRequestIdSchema } from '../apis/records.ts';
import { TaskRefSchema } from '../resources/task.ts';
import {
  CreateTaskCommandSchema,
  WorkLifecycleConflict,
  WorkNotFound,
  WorkPersistenceUnavailable,
  WorkReferenceIneligible,
  WorkReferenceUnavailable,
  WorkRevisionConflict,
  WorkScopeMismatch,
} from './apply-command.ts';

/**
 * A storefront files one customer inquiry as a new task. Only the text of `CreateTask` and the inquiry itself are
 * accepted: the storefront never chooses an assignee, due date, priority, project, customer or context record, and it
 * names no tenant or company — the trusted scope of its own key decides both. Any other field is refused.
 */
export const SubmitStorefrontInquiryPayloadSchema = Schema.Struct({
  ...Struct.pick(CreateTaskCommandSchema.fields, ['description', 'title']),
  storefrontInquiry: StorefrontInquirySchema,
});
export type SubmitStorefrontInquiryPayload = typeof SubmitStorefrontInquiryPayloadSchema.Type;

/** An acknowledgement only: the storefront learns which task holds its inquiry, never the task itself. */
export const SubmitStorefrontInquiryResultSchema = Schema.Struct({
  requestId: StorefrontRequestIdSchema,
  taskRef: TaskRefSchema,
});
export type SubmitStorefrontInquiryResult = typeof SubmitStorefrontInquiryResultSchema.Type;

/** The create path shared with `CreateTask`; an inquiry names no task, project or assignee, so 404/422 stay unused. */
export const SubmitStorefrontInquiryErrorSchema = Schema.Union([
  WorkScopeMismatch,
  WorkNotFound,
  WorkLifecycleConflict,
  WorkRevisionConflict,
  WorkPersistenceUnavailable,
  WorkReferenceUnavailable,
  WorkReferenceIneligible,
]);
