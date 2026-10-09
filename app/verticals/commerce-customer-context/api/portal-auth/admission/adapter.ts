import { makeTrustedAuthenticationAdmissionService } from '@app/core-runtime/auth/external-identity-admission';
import type {
  AuthenticationAdmissionRequest,
  AuthenticationNamespaceRegistry,
  ExternalIdentityFailure,
  TrustedAdmissionObservation,
  VerifiedAuthenticationAdmission,
} from '@app/core-runtime/auth/external-identity-admission';
import { OperationAuthenticationRequired, OperationContextUnavailable } from '@app/core-runtime';
import type { ExternalOperationAuthenticationRequest } from '@app/core-runtime/operations/external-authentication';
import { Effect, Layer } from 'effect';
import type { Clock } from 'effect';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../../shared/portal-auth-contracts.ts';
import { CommercePortalAuthAdmissionAdapter } from './adapter-service.ts';
import type { CommercePortalAuthAdmissionAdapterService } from './adapter-service.ts';
import { CommercePortalAuthBindingProjectionResolver } from './projection-resolver.ts';
import type { CommercePortalAuthBindingProjection } from './projection-resolver.ts';
import { CommercePortalAuthTrustedAdmissionConfigurationService } from './trusted-config.ts';

const required = (reason: string) =>
  new OperationAuthenticationRequired({ code: 'operation_authentication_required', reason });
const unavailable = (reason: string) =>
  new OperationContextUnavailable({ code: 'operation_context_unavailable', reason });

const projectionUnavailable = (cause: unknown) =>
  Object.defineProperty(unavailable('The Commerce admission binding projection is unavailable'), 'cause', {
    configurable: true,
    value: cause,
  });

const mapCoreFailure = (failure: ExternalIdentityFailure) =>
  failure.code === 'identity_unavailable'
    ? unavailable('Commerce provider verification is unavailable')
    : required('Commerce provider verification did not authorize this operation');

const validProjection = (
  input: ExternalOperationAuthenticationRequest,
  projection: CommercePortalAuthBindingProjection,
): boolean =>
  input.authenticationNamespaceId === COMMERCE_AUTHENTICATION_NAMESPACE_ID &&
  input.subjectType === 'user' &&
  input.principal.authMethod === 'session' &&
  input.principal.principalId === input.principalId &&
  input.principal.authBindingId === input.authBindingId &&
  input.principal.authenticationNamespaceId === input.authenticationNamespaceId &&
  input.principal.authContextRef === input.authContextRef &&
  input.principal.tenantId === input.tenantId &&
  projection.sessionRef === input.authContextRef &&
  Number.isSafeInteger(projection.bindingRevision) &&
  projection.bindingRevision >= 1;

const trustedRequest = (input: ExternalOperationAuthenticationRequest): AuthenticationAdmissionRequest => ({
  audience: input.audience,
  authBindingId: input.authBindingId,
  authContextRef: input.authContextRef,
  authenticationNamespaceId: input.authenticationNamespaceId,
  nonce: input.nonce,
  operationRef: input.operationRef,
  principalId: input.principalId,
  subjectType: input.subjectType,
  tenantId: input.tenantId,
});

const makeCommercePortalAuthAdmissionAdapter = Effect.fn('CommercePortalAuthAdmissionAdapter.make')(
  function* makeCommercePortalAuthAdmissionAdapter(): Effect.fn.Return<
    CommercePortalAuthAdmissionAdapterService,
    never,
    CommercePortalAuthBindingProjectionResolver | CommercePortalAuthTrustedAdmissionConfigurationService
  > {
    const resolver = yield* CommercePortalAuthBindingProjectionResolver;
    const configuration = yield* CommercePortalAuthTrustedAdmissionConfigurationService;
    const trusted = makeTrustedAuthenticationAdmissionService(configuration);

    const verify = Effect.fn('CommercePortalAuthAdmissionAdapter.verify')(function* verify(
      input: ExternalOperationAuthenticationRequest,
    ): Effect.fn.Return<
      VerifiedAuthenticationAdmission,
      OperationAuthenticationRequired | OperationContextUnavailable,
      AuthenticationNamespaceRegistry | Clock.Clock | TrustedAdmissionObservation
    > {
      const projection = yield* Effect.try({
        catch: projectionUnavailable,
        try: () => resolver.resolve(input),
      });
      if (projection === undefined) {
        return yield* unavailable('The Commerce admission binding projection is unavailable');
      }
      if (!validProjection(input, projection)) {
        return yield* required('The Commerce admission binding does not match the operation');
      }

      return yield* trusted.verify(trustedRequest(input)).pipe(Effect.mapError(mapCoreFailure));
    });

    return { verify };
  },
);

/**
 * The Commerce admission adapter as an installable Layer. Composition provides the binding
 * projection resolver and the trusted admission configuration; the adapter tag is what the
 * Commerce composition root yields before installing Core's `ExternalOperationAuthentication`.
 */
export const commercePortalAuthAdmissionAdapterLive = Layer.effect(
  CommercePortalAuthAdmissionAdapter,
  makeCommercePortalAuthAdmissionAdapter(),
);
