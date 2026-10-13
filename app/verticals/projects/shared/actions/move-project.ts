import { Schema } from 'effect';
import { ProjectUuidSchema } from '../domain/project.ts';

export { ProjectSchema as MoveProjectResultSchema } from '../domain/project.ts';
export const MoveProjectPayloadSchema = Schema.Struct({
  parentProjectId: Schema.OptionFromNullOr(ProjectUuidSchema),
  projectId: ProjectUuidSchema,
});
export type MoveProjectPayload = typeof MoveProjectPayloadSchema.Type;
