import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import type { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { Context, Effect, Layer, Schema } from 'effect';
import type { Redacted } from 'effect';
import type { CommercePortalAuthVerificationRequest } from '../../../shared/portal-auth-verification.ts';
import {
  CommercePortalAuthVerificationWorkloadGrantConfiguration,
  CommercePortalAuthVerificationWorkloadGrantsSchema,
} from './workload-grants.ts';
import type {
  CommercePortalAuthVerificationWorkloadGrant,
  CommercePortalAuthVerificationWorkloadGrants,
} from './workload-grants.ts';

export const CommercePortalAuthVerificationWorkloadRejected = Schema.TaggedStruct(
  'CommercePortalAuthVerificationWorkloadRejected',
  { reason: Schema.String },
);
type CommercePortalAuthVerificationWorkloadRejectedError = typeof CommercePortalAuthVerificationWorkloadRejected.Type;

export const CommercePortalAuthVerificationWorkloadUnavailable = Schema.TaggedStruct(
  'CommercePortalAuthVerificationWorkloadUnavailable',
  { reason: Schema.String },
);
type CommercePortalAuthVerificationWorkloadUnavailableError =
  typeof CommercePortalAuthVerificationWorkloadUnavailable.Type;

export interface CommercePortalAuthVerificationWorkloadAuthorizationInput {
  readonly authorization: Redacted.Redacted<string | undefined>;
  readonly request: CommercePortalAuthVerificationRequest;
  readonly requestCorrelation: string | undefined;
}

export interface CommercePortalAuthVerificationWorkloadAuthorizationService {
  readonly authorize: (
    input: CommercePortalAuthVerificationWorkloadAuthorizationInput,
  ) => Effect.Effect<
    void,
    CommercePortalAuthVerificationWorkloadRejectedError | CommercePortalAuthVerificationWorkloadUnavailableError,
    | CommercePortalAuthVerificationWorkloadGrantConfiguration
    | GatewayAssertionRedemptionService
    | GatewayPrincipalVerifierConfiguration
  >;
}

export class CommercePortalAuthVerificationWorkloadAuthorization extends Context.Service<
  CommercePortalAuthVerificationWorkloadAuthorization,
  CommercePortalAuthVerificationWorkloadAuthorizationService
>()(
  '@app/commerce-customer-context/api/portal-auth/verification-http/workload-authorization/CommercePortalAuthVerificationWorkloadAuthorization',
) {}

const rejected = (reason: string) => CommercePortalAuthVerificationWorkloadRejected.make({ reason });
const unavailable = (reason: string) => CommercePortalAuthVerificationWorkloadUnavailable.make({ reason });
const gatewayAssertionRejected = () => Effect.fail(rejected('The workload gateway assertion is not authorized'));
const gatewayVerificationUnavailable = () => Effect.fail(unavailable('Workload gateway verification is unavailable'));

const decodeGrantConfiguration = (configuration: CommercePortalAuthVerificationWorkloadGrants) =>
  Schema.decodeEffect(CommercePortalAuthVerificationWorkloadGrantsSchema, { onExcessProperty: 'error' })(
    configuration,
  ).pipe(
    Effect.filterOrFail(
      ({ grants }) =>
        grants.every(
          ({ commerceAuthenticationNamespaceId, workloadAuthenticationNamespaceId }) =>
            commerceAuthenticationNamespaceId !== workloadAuthenticationNamespaceId,
        ),
      () => unavailable('The workload grant namespaces are not distinct'),
    ),
    Effect.mapError((cause) =>
      Object.defineProperty(unavailable('The workload grant configuration is unavailable'), 'cause', {
        configurable: true,
        value: cause,
      }),
    ),
  );

const matchesGrant = (
  principal: {
    readonly authenticationNamespaceId?: string;
    readonly authMethod: string;
    readonly impersonatedByPrincipalId?: string;
    readonly principalId: string;
    readonly tenantId: string;
  },
  request: CommercePortalAuthVerificationRequest,
  grant: CommercePortalAuthVerificationWorkloadGrant,
): boolean =>
  principal.authMethod === 'api_key' &&
  principal.impersonatedByPrincipalId === undefined &&
  principal.authenticationNamespaceId === grant.workloadAuthenticationNamespaceId &&
  principal.principalId === grant.workloadPrincipalId &&
  principal.tenantId === grant.tenantId &&
  request.tenantId === grant.tenantId &&
  request.authenticationNamespaceId === grant.commerceAuthenticationNamespaceId &&
  request.audience === grant.receivingAudience &&
  request.operation === grant.operation;

const authorize = Effect.fn('CommercePortalAuthVerificationWorkloadAuthorization.authorize')(function* authorize(
  input: CommercePortalAuthVerificationWorkloadAuthorizationInput,
): Effect.fn.Return<
  void,
  CommercePortalAuthVerificationWorkloadRejectedError | CommercePortalAuthVerificationWorkloadUnavailableError,
  | CommercePortalAuthVerificationWorkloadGrantConfiguration
  | GatewayAssertionRedemptionService
  | GatewayPrincipalVerifierConfiguration
> {
  const configured = yield* CommercePortalAuthVerificationWorkloadGrantConfiguration;
  const configuration = yield* decodeGrantConfiguration(configured);
  if (configuration.grants.length === 0) {
    return yield* Effect.fail(rejected('No trusted workload grant is configured'));
  }
  const redemption = yield* GatewayAssertionRedemptionService;
  const verifier = bindGatewayPrincipalVerifier(configuration.providerEndpointAudience);
  const principal = yield* verifier.verifyAndRedeem(input.authorization, { redemption }).pipe(
    Effect.catchTags({
      ActionPrincipalConfigurationError: gatewayVerificationUnavailable,
      ActionPrincipalExpiredError: gatewayAssertionRejected,
      ActionPrincipalInvalidError: gatewayAssertionRejected,
      ActionPrincipalMissingError: gatewayAssertionRejected,
      ActionPrincipalScopeError: gatewayAssertionRejected,
      ActionPrincipalUnavailableError: gatewayVerificationUnavailable,
    }),
  );
  const grant = configuration.grants.find((candidate) => matchesGrant(principal, input.request, candidate));
  if (grant === undefined) {
    return yield* Effect.fail(rejected('The workload principal is not granted for this exact Commerce request'));
  }
  return undefined;
});

export const commercePortalAuthVerificationWorkloadAuthorizationLive = Layer.succeed(
  CommercePortalAuthVerificationWorkloadAuthorization,
  { authorize },
);
