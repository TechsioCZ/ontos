// Canonical schema-only relocation of the Codesmith privacy.core Privacy Subject resource reference.
import { Schema } from 'effect';

const ResourceIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(Schema.brand('PrivacyResourceId')),
);
const TenantIdSchema = Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyTenantId')));

export const PrivacySubjectRefSchema = Schema.Struct({
  moduleId: Schema.Literal('privacy.core'),
  resourceId: ResourceIdSchema,
  resourceType: Schema.Literal('privacy.core.privacy-subject'),
  tenantId: TenantIdSchema,
});
export type PrivacySubjectRef = typeof PrivacySubjectRefSchema.Type;
