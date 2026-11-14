import { Schema } from 'effect';
import { CreatePartyPayloadSchema } from './create-party.ts';

export { CreatePartyResultSchema as CreateCrmClientPartyResultSchema } from './create-party.ts';

/** A CRM-owned client snapshot, attested only by its admitted module acting for the intake workload. */
export const CreateCrmClientPartyPayloadSchema = Schema.Struct({
  candidate: CreatePartyPayloadSchema.fields.candidate,
  sourceScope: Schema.Struct({
    tenantId: Schema.String.check(Schema.isUUID()),
    legalEntityId: Schema.String.check(Schema.isUUID()),
  }),
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
