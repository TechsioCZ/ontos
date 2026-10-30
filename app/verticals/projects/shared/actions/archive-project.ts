import { Schema } from 'effect';
import { ProjectUuidSchema } from '../domain/project.ts';

export { ProjectSchema as ArchiveProjectResultSchema } from '../domain/project.ts';
export const ArchiveProjectPayloadSchema = Schema.Struct({ projectId: ProjectUuidSchema });
export type ArchiveProjectPayload = typeof ArchiveProjectPayloadSchema.Type;
