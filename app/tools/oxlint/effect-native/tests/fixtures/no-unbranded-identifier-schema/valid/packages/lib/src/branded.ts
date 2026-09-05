import { pipe, Schema } from 'effect';

// Every audit-blessed way of introducing the brand.
export const TenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'));
export const PrincipalIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId'));
export const ModuleIdSchema = pipe(Schema.String, Schema.brand('ModuleId'));
export const ContactsIcoSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/u)).pipe(
  Schema.brand('ContactsIco'),
);
export const DeploymentIdSchema = Schema.NullOr(Schema.String.pipe(Schema.brand('DeploymentId')));

export const IdentitySchema = Schema.Struct({
  tenantId: TenantIdSchema,
  principalId: PrincipalIdSchema,
  moduleId: Schema.optionalKey(ModuleIdSchema),
  ico: ContactsIcoSchema,
  deploymentId: DeploymentIdSchema,
});
