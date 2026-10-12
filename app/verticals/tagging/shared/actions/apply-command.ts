import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { TaggingScopeMismatch } from '../errors/tagging-scope-mismatch.ts';
import { TaggingNotFound } from '../errors/tagging-not-found.ts';
import { TaggingLifecycleConflict } from '../errors/tagging-lifecycle-conflict.ts';
import { TaggingRevisionConflict } from '../errors/tagging-revision-conflict.ts';
import { TaggingPersistenceUnavailable } from '../errors/tagging-persistence-unavailable.ts';
import { TaggingReferenceUnavailable } from '../errors/tagging-reference-unavailable.ts';
import { TaggingReferenceIneligible } from '../errors/tagging-reference-ineligible.ts';
import { TaggingPermissionDenied } from '../errors/tagging-permission-denied.ts';
import { CalendarDateSchema, ContextRefSchema, TagPrioritySchema, TagSchema, TagStateSchema } from '../apis/records.ts';
import { TagRefSchema } from '../resources/tag.ts';

const editableFields = {
  description: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  dueDate: Schema.optionalKey(CalendarDateSchema),
  ownerPrincipalRef: Schema.optionalKey(PrincipalRefSchema),
  priority: Schema.optionalKey(TagPrioritySchema),
};
export const TaggingCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateTag', {
    ...editableFields,
    contextRefs: Schema.optionalKey(Schema.Array(ContextRefSchema).check(Schema.isMaxLength(12))),
    title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.TaggedStruct('UpdateTag', {
    ...editableFields,
    tagRef: TagRefSchema,
    title: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
  Schema.TaggedStruct('AssignTag', { ownerPrincipalRef: PrincipalRefSchema, tagRef: TagRefSchema }),
  Schema.TaggedStruct('ChangeTagState', { state: TagStateSchema, tagRef: TagRefSchema }),
]);
export type TaggingCommand = typeof TaggingCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: TaggingCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({ revision: Schema.Int, tag: TagSchema });
export const TaggingErrorSchema = Schema.Union([
  TaggingScopeMismatch,
  TaggingNotFound,
  TaggingLifecycleConflict,
  TaggingRevisionConflict,
  TaggingPersistenceUnavailable,
  TaggingReferenceUnavailable,
  TaggingReferenceIneligible,
  TaggingPermissionDenied,
]);
export type TaggingError = typeof TaggingErrorSchema.Type;
export { TaggingScopeMismatch } from '../errors/tagging-scope-mismatch.ts';
export { TaggingNotFound } from '../errors/tagging-not-found.ts';
export { TaggingLifecycleConflict } from '../errors/tagging-lifecycle-conflict.ts';
export { TaggingRevisionConflict } from '../errors/tagging-revision-conflict.ts';
export { TaggingPersistenceUnavailable } from '../errors/tagging-persistence-unavailable.ts';
export { TaggingReferenceUnavailable } from '../errors/tagging-reference-unavailable.ts';
export { TaggingReferenceIneligible } from '../errors/tagging-reference-ineligible.ts';
export { TaggingPermissionDenied } from '../errors/tagging-permission-denied.ts';
