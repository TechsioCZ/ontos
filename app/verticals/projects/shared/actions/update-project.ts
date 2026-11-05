import { Schema } from 'effect';
import { ProjectNameSchema, ProjectShortTextSchema, ProjectUuidSchema } from '../domain/project.ts';

export { ProjectSchema as UpdateProjectResultSchema } from '../domain/project.ts';
/**
 * The editable fields of a Project. `ownerPrincipalId` is deliberately absent: handing a Project to
 * another person is reassignment (O10), never a routine edit, and needs its own capability. Keeping
 * the field out of the payload means no `update` grant can ever express an owner change.
 */
export const UpdateProjectPayloadSchema = Schema.Struct({
  name: Schema.optionalKey(ProjectNameSchema),
  projectId: ProjectUuidSchema,
  shortText: Schema.optionalKey(Schema.OptionFromNullOr(ProjectShortTextSchema)),
}).check(
  Schema.makeFilter((payload) =>
    payload.name === undefined && payload.shortText === undefined
      ? 'At least one editable Project field must be supplied'
      : undefined,
  ),
);
export type UpdateProjectPayload = typeof UpdateProjectPayloadSchema.Type;
