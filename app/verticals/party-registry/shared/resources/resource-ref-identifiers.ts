import { Schema } from 'effect';

export const PartyRegistryResourceIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('PartyRegistryResourceId'));
export const PartyRegistryTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('TenantId'),
);

/** JSON-compatible views keep published ResourceRef fields as strings. */
export const PartyRegistryResourceIdJsonSchema = Schema.toEncoded(PartyRegistryResourceIdSchema);
export const PartyRegistryTenantIdJsonSchema = Schema.toEncoded(PartyRegistryTenantIdSchema);
