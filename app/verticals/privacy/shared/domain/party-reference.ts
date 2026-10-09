import { Schema } from 'effect';

const PartyResourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
  Schema.brand('PartyResourceId'),
);
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));

/**
 * Consumer-side validation for Party Registry's published opaque Party reference.
 * Privacy stores the reference only; Party Registry remains its canonical owner.
 */
export const PrivacyPartyRefSchema = Schema.Struct({
  moduleId: Schema.Literal('party.registry'),
  resourceId: PartyResourceIdSchema,
  resourceType: Schema.Literal('party.registry.party'),
  tenantId: TenantIdSchema,
});
export type PrivacyPartyRef = typeof PrivacyPartyRefSchema.Type;
