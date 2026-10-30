import { Schema } from 'effect';
import {
  ProjectUuidSchema,
  ProjectNameSchema,
  ProjectShortTextSchema,
  ProjectPrefixInputSchema,
} from '../domain/project.ts';

export { ProjectSchema as CreateProjectResultSchema } from '../domain/project.ts';
export const CreateProjectPayloadSchema = Schema.Struct({
  name: ProjectNameSchema,
  ownerPrincipalId: ProjectUuidSchema,
  parentProjectId: Schema.optionalKey(Schema.OptionFromNullOr(ProjectUuidSchema)),
  prefix: ProjectPrefixInputSchema,
  shortText: Schema.optionalKey(Schema.OptionFromNullOr(ProjectShortTextSchema)),
});
export type CreateProjectPayload = typeof CreateProjectPayloadSchema.Type;
