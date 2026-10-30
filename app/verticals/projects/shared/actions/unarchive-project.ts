import { Schema } from 'effect';
import { ProjectUuidSchema } from '../domain/project.ts';

export { ProjectSchema as UnarchiveProjectResultSchema } from '../domain/project.ts';
export const UnarchiveProjectPayloadSchema = Schema.Struct({ projectId: ProjectUuidSchema });
export type UnarchiveProjectPayload = typeof UnarchiveProjectPayloadSchema.Type;
