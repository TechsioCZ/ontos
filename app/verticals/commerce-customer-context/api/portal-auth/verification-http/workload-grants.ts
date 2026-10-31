import { Config, Context, Effect, Layer, Option, Schema } from 'effect';
import { ultramodernApiMarker } from '../../../shared/ultramodern-build.ts';

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
});

export const CommercePortalAuthVerificationWorkloadGrantsSchema = Schema.Struct({
  grants: Schema.Array(CommercePortalAuthVerificationWorkloadGrantSchema),
  providerEndpointAudience: boundedReference,
});

export type CommercePortalAuthVerificationWorkloadGrant = typeof CommercePortalAuthVerificationWorkloadGrantSchema.Type;
export type CommercePortalAuthVerificationWorkloadGrants =
  typeof CommercePortalAuthVerificationWorkloadGrantsSchema.Type;

export class CommercePortalAuthVerificationWorkloadGrantConfiguration extends Context.Service<
  CommercePortalAuthVerificationWorkloadGrantConfiguration,
  CommercePortalAuthVerificationWorkloadGrants
>()(
  '@app/commerce-customer-context/api/portal-auth/verification-http/workload-grants/CommercePortalAuthVerificationWorkloadGrantConfiguration',
) {}

/** Absent configuration denies all callers; malformed deployment data fails construction closed. */
export const CommercePortalAuthVerificationWorkloadGrantConfigurationLive = Layer.effect(
  CommercePortalAuthVerificationWorkloadGrantConfiguration,
  Config.option(Config.String('COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS')).pipe(
    Effect.flatMap((value) =>
      Option.isSome(value)
        ? Schema.decodeEffect(Schema.fromJsonString(CommercePortalAuthVerificationWorkloadGrantsSchema), {
            onExcessProperty: 'error',
          })(value.value)
        : Effect.succeed({ grants: [], providerEndpointAudience: ultramodernApiMarker.appId }),
    ),
  ),
);
