import { Schema } from 'effect';

const uuid = Schema.String.check(Schema.isUUID());
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const TrustedPrincipalContextSchema = Schema.Struct({
  authBindingId: Schema.optionalKey(uuid),
  authContextRef: Schema.optionalKey(nonEmptyString),
  authMethod: Schema.Literals(['session', 'api_key', 'system', 'support_impersonation']),
  impersonatedByPrincipalId: Schema.optionalKey(uuid),
  legalEntityId: Schema.optionalKey(uuid),
  principalId: uuid,
  tenantId: uuid,
});

export type TrustedPrincipalContext = Schema.Schema.Type<typeof TrustedPrincipalContextSchema>;
