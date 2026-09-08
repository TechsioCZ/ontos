import { Schema } from 'effect';

// `Schema.String.brand(...)` (method form) also brands.
export const LegalEntityIdSchema = Schema.String.brand('LegalEntityId');

export const OwnerSchema = Schema.Struct({
  legalEntityId: LegalEntityIdSchema,
  ownerKey: Schema.String.brand('OwnerKey'),
});
