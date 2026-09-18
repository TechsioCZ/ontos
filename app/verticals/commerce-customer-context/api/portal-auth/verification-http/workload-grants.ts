import { Context, Schema } from 'effect';

import {
  AuthenticationNamespaceIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { COMMERCE_PORTAL_AUTH_VERIFY_OPERATION } from '../../../shared/portal-auth-verification.ts';

const boundedReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

const CommercePortalAuthVerificationWorkloadGrantSchema = Schema.Struct({
  commerceAuthenticationNamespaceId: AuthenticationNamespaceIdSchema,
  operation: Schema.Literal(COMMERCE_PORTAL_AUTH_VERIFY_OPERATION),
  receivingAudience: boundedReference,
  tenantId: TenantIdSchema,
  workloadAuthenticationNamespaceId: AuthenticationNamespaceIdSchema,
  workloadPrincipalId: PrincipalIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export const CommercePortalAuthVerificationWorkloadGrantsSchema = Schema.Struct({
  grants: Schema.Array(CommercePortalAuthVerificationWorkloadGrantSchema),
  providerEndpointAudience: boundedReference,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type CommercePortalAuthVerificationWorkloadGrant = typeof CommercePortalAuthVerificationWorkloadGrantSchema.Type;
export type CommercePortalAuthVerificationWorkloadGrants =
  typeof CommercePortalAuthVerificationWorkloadGrantsSchema.Type;

export class CommercePortalAuthVerificationWorkloadGrantConfiguration extends Context.Service<
  CommercePortalAuthVerificationWorkloadGrantConfiguration,
  CommercePortalAuthVerificationWorkloadGrants
>()(
  '@app/commerce-customer-context/api/portal-auth/verification-http/workload-grants/CommercePortalAuthVerificationWorkloadGrantConfiguration',
) {}
