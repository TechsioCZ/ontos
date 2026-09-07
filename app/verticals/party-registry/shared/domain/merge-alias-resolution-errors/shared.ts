import { Schema } from 'effect';

export const PartyIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('PartyId'),
);
export const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
export const PartyIdJsonSchema = Schema.toEncoded(PartyIdSchema);
export const TenantIdJsonSchema = Schema.toEncoded(TenantIdSchema);
