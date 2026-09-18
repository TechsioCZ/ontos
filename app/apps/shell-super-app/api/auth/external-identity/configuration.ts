import { AuthenticationNamespaceIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { GatewayAudienceSchema } from '@app/shared-contracts';
import { Context, Schema } from 'effect';

/** The six operations are part of workload grant configuration, not request authority. */
const ExternalIdentityWorkloadOperationSchema = Schema.Literals([
  'activate',
  'gateway-context',
  'read',
  'resolve',
  'reserve',
  'status',
]);
export type ExternalIdentityWorkloadOperation = typeof ExternalIdentityWorkloadOperationSchema.Type;

const ExternalIdentityWorkloadGrantSchema = Schema.Struct({
  operation: ExternalIdentityWorkloadOperationSchema,
  receivingAudience: GatewayAudienceSchema,
  targetAudience: Schema.optionalKey(GatewayAudienceSchema),
  targetAuthenticationNamespaceId: Schema.optionalKey(AuthenticationNamespaceIdSchema),
  tenantId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId')),
  workloadAuthenticationNamespaceId: AuthenticationNamespaceIdSchema,
  workloadPrincipalId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId')),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export const ExternalIdentityHttpConfigurationSchema = Schema.Struct({
  grants: Schema.Array(ExternalIdentityWorkloadGrantSchema),
  providerEndpointAudience: GatewayAudienceSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ExternalIdentityWorkloadGrant = typeof ExternalIdentityWorkloadGrantSchema.Type;
export type ExternalIdentityHttpConfiguration = typeof ExternalIdentityHttpConfigurationSchema.Type;

/** Trusted Shell deployment configuration for the external-identity workload boundary. */
export class ExternalIdentityHttpConfigurationService extends Context.Service<
  ExternalIdentityHttpConfigurationService,
  ExternalIdentityHttpConfiguration
>()('@app/shell-super-app/api/auth/external-identity/configuration/ExternalIdentityHttpConfigurationService') {}
