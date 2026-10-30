import { Schema } from 'effect';

export const ProjectUuidSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ProjectId'),
  Schema.decodeTo(Schema.String),
);
export const ProjectPrefixInputSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z]{2,5}$/u));
export const ProjectPrefixSchema = Schema.String.check(Schema.isPattern(/^[A-Z]{2,5}$/u));
export const ProjectNameSchema = Schema.String.check(Schema.isPattern(/\S/u));
export const ProjectShortTextSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    let count = 0;
    for (const character of value) {
      count += character.length > 0 ? 1 : 0;
    }
    return count <= 255 ? undefined : 'shortText must contain at most 255 Unicode characters';
  }),
);
export const ProjectLifecycleStateSchema = Schema.Literals(['active', 'archived']);
export const ProjectTimestampSchema = Schema.DateTimeUtcFromString;

export const normalizeProjectPrefix = (prefix: string): string => prefix.toUpperCase();

export const ProjectSchema = Schema.Struct({
  createdAt: ProjectTimestampSchema,
  createdByPrincipalId: ProjectUuidSchema,
  lifecycleState: ProjectLifecycleStateSchema,
  name: ProjectNameSchema,
  ownerPrincipalId: ProjectUuidSchema,
  parentProjectId: Schema.OptionFromNullOr(ProjectUuidSchema),
  prefix: ProjectPrefixSchema,
  projectId: ProjectUuidSchema,
  shortText: Schema.OptionFromNullOr(ProjectShortTextSchema),
  tenantId: ProjectUuidSchema,
});

export type Project = typeof ProjectSchema.Type;
export type ProjectLifecycleState = typeof ProjectLifecycleStateSchema.Type;

export { ProjectNotFound } from './project-not-found.ts';
export { ProjectPrefixConflict } from './project-prefix-conflict.ts';
export { ProjectHierarchyConflict } from './project-hierarchy-conflict.ts';
export { ProjectLifecycleConflict } from './project-lifecycle-conflict.ts';
export { ProjectPersistenceUnavailable } from './project-persistence-unavailable.ts';
