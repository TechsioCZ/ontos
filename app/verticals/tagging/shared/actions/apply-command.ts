import { Schema } from 'effect';
import { TaggingScopeMismatch } from '../errors/tagging-scope-mismatch.ts';
import { TaggingNotFound } from '../errors/tagging-not-found.ts';
import { TaggingLifecycleConflict } from '../errors/tagging-lifecycle-conflict.ts';
import { TaggingRevisionConflict } from '../errors/tagging-revision-conflict.ts';
import { TaggingPersistenceUnavailable } from '../errors/tagging-persistence-unavailable.ts';
import { TaggingReferenceUnavailable } from '../errors/tagging-reference-unavailable.ts';
import { TaggingReferenceIneligible } from '../errors/tagging-reference-ineligible.ts';
import { TaggingPermissionDenied } from '../errors/tagging-permission-denied.ts';
import { SubjectKindSchema, SubjectSchema, TagColorSchema, TagIdSchema } from '../apis/records.ts';

const NameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(60));
const DescriptionSchema = Schema.Trim.check(Schema.isMaxLength(2000));
const SubjectKindsSchema = Schema.Array(SubjectKindSchema).check(Schema.isMinLength(1), Schema.isMaxLength(5));
const SubjectsSchema = Schema.Array(SubjectSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500));

export const TaggingCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateTag', {
    color: TagColorSchema,
    description: Schema.optionalKey(DescriptionSchema),
    name: NameSchema,
    subjectKinds: SubjectKindsSchema,
  }),
  Schema.TaggedStruct('UpdateTag', {
    id: TagIdSchema,
    // An empty description clears the stored description.
    patch: Schema.Struct({
      color: Schema.optionalKey(TagColorSchema),
      description: Schema.optionalKey(DescriptionSchema),
      name: Schema.optionalKey(NameSchema),
      subjectKinds: Schema.optionalKey(SubjectKindsSchema),
    }),
  }),
  Schema.TaggedStruct('DeleteTag', { id: TagIdSchema }),
  Schema.TaggedStruct('AssignTag', { subjects: SubjectsSchema, tagId: TagIdSchema }),
  Schema.TaggedStruct('UnassignTag', { subjects: SubjectsSchema, tagId: TagIdSchema }),
]);
export type TaggingCommand = typeof TaggingCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: TaggingCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
/** `tagId` is the created tag for CreateTag and the affected tag otherwise. `affectedAssignments` counts rows added, removed or cascaded. */
export const ApplyCommandResultSchema = Schema.Struct({
  affectedAssignments: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  revision: Schema.Int,
  tagId: TagIdSchema,
});
export type ApplyCommandResult = typeof ApplyCommandResultSchema.Type;
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
