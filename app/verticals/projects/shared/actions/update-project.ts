import { Schema } from 'effect';
import { ProjectNameSchema, ProjectShortTextSchema, ProjectUuidSchema } from '../domain/project.ts';

export { ProjectSchema as UpdateProjectResultSchema } from '../domain/project.ts';
export const UpdateProjectPayloadSchema = Schema.Struct({
  name: Schema.optionalKey(ProjectNameSchema),
  ownerPrincipalId: Schema.optionalKey(ProjectUuidSchema),
  projectId: ProjectUuidSchema,
  shortText: Schema.optionalKey(Schema.OptionFromNullOr(ProjectShortTextSchema)),
}).check(
  Schema.makeFilter((payload) =>
    payload.name === undefined && payload.ownerPrincipalId === undefined && payload.shortText === undefined
      ? 'At least one editable Project field must be supplied'
      : undefined,
  ),
);
export type UpdateProjectPayload = typeof UpdateProjectPayloadSchema.Type;
