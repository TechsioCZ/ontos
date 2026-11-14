import { Schema } from 'effect';
import { EntityIdSchema } from '../domain/common.ts';

export { CrmErrorSchema as IntakeClientPartyErrorSchema } from './apply-command.ts';

/** No Party claim, tenant, company, actor or client identity fields come from this request. */
export const IntakeClientPartyPayloadSchema = Schema.Struct({
  clientId: EntityIdSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const IntakeClientPartyResultSchema = Schema.Struct({
  entityIds: Schema.Array(EntityIdSchema),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.Literals(['linked', 'review', 'unchanged']),
});
export type IntakeClientPartyPayload = typeof IntakeClientPartyPayloadSchema.Type;
export type IntakeClientPartyResult = typeof IntakeClientPartyResultSchema.Type;
