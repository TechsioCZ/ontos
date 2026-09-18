import { Schema } from 'effect';

const ReferenceId = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ModuleId = ReferenceId.pipe(Schema.brand('ModuleId'));
const ResourceId = ReferenceId.pipe(Schema.brand('ResourceId'));
const TenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));

/** A pointer to a fact owned by another module; the pointed-to record remains in that owner's system. */
export const PrivacyOwnerResourceRefSchema = Schema.Struct({
  moduleId: ModuleId,
  resourceId: ResourceId,
  resourceType: ReferenceId,
  tenantId: TenantId,
});
export type PrivacyOwnerResourceRef = typeof PrivacyOwnerResourceRefSchema.Type;
