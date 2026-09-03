/* eslint-disable max-classes-per-file -- The closed Project error vocabulary is intentionally colocated with its domain schema. */
import { Schema } from 'effect';

export const ProjectUuidSchema = Schema.String.check(Schema.isUUID());
export const ProjectPrefixInputSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z]{2,5}$/u));
export const ProjectPrefixSchema = Schema.String.check(Schema.isPattern(/^[A-Z]{2,5}$/u));
export const ProjectNameSchema = Schema.String.check(Schema.isPattern(/\S/u));
export const ProjectShortTextSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    [...value].length <= 255 ? undefined : 'shortText must contain at most 255 Unicode characters',
  ),
);
export const ProjectLifecycleStateSchema = Schema.Literals(['active', 'archived']);
export const ProjectTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
);

export const normalizeProjectPrefix = (prefix: string): string => prefix.toUpperCase();

export const ProjectSchema = Schema.Struct({
  createdAt: ProjectTimestampSchema,
  createdByPrincipalId: ProjectUuidSchema,
  lifecycleState: ProjectLifecycleStateSchema,
  name: ProjectNameSchema,
  ownerPrincipalId: ProjectUuidSchema,
  parentProjectId: Schema.NullOr(ProjectUuidSchema),
  prefix: ProjectPrefixSchema,
  projectId: ProjectUuidSchema,
  shortText: Schema.NullOr(ProjectShortTextSchema),
  tenantId: ProjectUuidSchema,
});

export type Project = typeof ProjectSchema.Type;
export type ProjectLifecycleState = typeof ProjectLifecycleStateSchema.Type;

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()('ProjectNotFound', {
  code: Schema.Literal('project_not_found'),
  reason: Schema.String,
}) {}

export class ProjectPrefixConflict extends Schema.TaggedError<ProjectPrefixConflict>()(
  'ProjectPrefixConflict',
  { code: Schema.Literal('project_prefix_conflict'), reason: Schema.String },
) {}

export class ProjectHierarchyConflict extends Schema.TaggedError<ProjectHierarchyConflict>()(
  'ProjectHierarchyConflict',
  { code: Schema.Literal('project_hierarchy_conflict'), reason: Schema.String },
) {}

export class ProjectLifecycleConflict extends Schema.TaggedError<ProjectLifecycleConflict>()(
  'ProjectLifecycleConflict',
  { code: Schema.Literal('project_lifecycle_conflict'), reason: Schema.String },
) {}

export class ProjectPersistenceUnavailable extends Schema.TaggedError<ProjectPersistenceUnavailable>()(
  'ProjectPersistenceUnavailable',
  { code: Schema.Literal('project_persistence_unavailable'), reason: Schema.String },
) {}
