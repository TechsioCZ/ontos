import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
  TrustedAuthenticationAdmissionService,
  TrustedExternalSubjectAdmissionService,
  makeTrustedAuthenticationAdmissionService,
  makeTrustedExternalSubjectAdmissionService,
} from '@app/core-runtime/auth/external-identity-admission';
import type { AuthenticationNamespaceRegistration } from '@app/core-runtime/auth/external-identity-contracts';
import {
  AuthenticationNamespaceRegistrationSchema,
  PrincipalIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import {
  COMMERCE_ADMISSION_DEADLINE_MS,
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  COMMERCE_CUSTOMER_CONTEXT_API_PREFIX,
} from '@app/commerce-customer-context/portal-auth/contracts';
import {
  CommercePortalAuthVerificationClientConfigurationService,
  CommercePortalAuthVerificationClientUnavailable,
  CommercePortalAuthVerificationWorkloadAssertion,
  commercePortalAuthVerificationClientLive,
} from '@app/commerce-customer-context/portal-auth/verification/client';
import { Effect, Layer, Redacted, Result, Schema } from 'effect';

import { GatewayIssuer } from './gateway-issuer.ts';
import type { ExternalIdentityDeploymentLayer } from './external-identity-runtime.ts';
import {
  ExternalIdentityHttpConfigurationSchema,
  ExternalIdentityHttpConfigurationService,
} from './external-identity/configuration.ts';
import { commerceAdmissionObservationLive } from './external-identity/commerce-admission-observation.ts';
import { ExternalIdentityHttpWorkloadContext } from './external-identity/request-context.ts';
import type { ExternalIdentityHttpWorkloadContextValue } from './external-identity/request-context.ts';
import { ExternalIdentityWorkloadAuthorization } from './external-identity/workload-authorization.ts';
import type { ExternalIdentityWorkloadGrantInput } from './external-identity/workload-authorization.ts';

type CommercePortalAuthVerificationWorkloadAssertionInput = Parameters<
  CommercePortalAuthVerificationWorkloadAssertion['Service']['acquire']
>[0];

const HttpOriginSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname === '/' &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'The Commerce provider origin must be an HTTP(S) origin without credentials, path, query, or fragment',
  ),
);

const CommerceExternalIdentityConfigurationSchema = Schema.Struct({
  ...ExternalIdentityHttpConfigurationSchema.fields,
  attesterPrincipalId: PrincipalIdSchema,
  authenticationNamespaceId: Schema.Literal(COMMERCE_AUTHENTICATION_NAMESPACE_ID),
  providerOrigin: HttpOriginSchema,
});

export { CommerceExternalIdentityConfigurationSchema };
export type CommerceExternalIdentityConfiguration = typeof CommerceExternalIdentityConfigurationSchema.Type;

export class CommerceExternalIdentityConfigurationError extends Schema.TaggedError<CommerceExternalIdentityConfigurationError>()(
  'CommerceExternalIdentityConfigurationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.String,
  },
) {}

const malformedConfiguration = (cause?: unknown): CommerceExternalIdentityConfigurationError =>
  cause === undefined
    ? new CommerceExternalIdentityConfigurationError({ reason: 'Commerce external identity configuration is invalid' })
    : new CommerceExternalIdentityConfigurationError({
        cause,
        reason: 'Commerce external identity configuration is invalid',
      });

const decodeCommerceExternalIdentityConfiguration = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Deployment input is decoded at the trusted composition boundary.
  input: unknown,
): Effect.Effect<CommerceExternalIdentityConfiguration, CommerceExternalIdentityConfigurationError> =>
  Schema.decodeUnknownEffect(CommerceExternalIdentityConfigurationSchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError((cause) => malformedConfiguration(cause)),
  );

const distinct = (values: readonly string[]): readonly string[] => [...new Set(values)];

/**
 * The Core verifier consumes this registration from the composition root.  It
 * is exported separately so the Shell can merge it with the staff registry
 * without replacing an already trusted namespace.
 */
export const makeCommerceAuthenticationNamespaceRegistration = (
  configuration: CommerceExternalIdentityConfiguration,
): AuthenticationNamespaceRegistration =>
  Result.getOrThrow(
    Schema.decodeResult(AuthenticationNamespaceRegistrationSchema)({
      allowedAudiences: distinct([
        configuration.providerEndpointAudience,
        ...configuration.grants.flatMap(({ targetAudience }) => (targetAudience === undefined ? [] : [targetAudience])),
      ]),
      authenticationNamespaceId: configuration.authenticationNamespaceId,
      provider: 'better-auth',
      requiresOperationAdmission: true,
      reservationPrincipalKind: 'human',
      subjectTypes: ['user'],
      trustedAttesterPrincipalIds: [configuration.attesterPrincipalId],
    }),
  );

export const makeCommerceAuthenticationNamespaceRegistry = (configuration: CommerceExternalIdentityConfiguration) =>
  makeAuthenticationNamespaceRegistry([makeCommerceAuthenticationNamespaceRegistration(configuration)]);

const makeCommerceAuthenticationNamespaceRegistryEffect = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Registry composition decodes untrusted deployment data once.
  input: unknown,
) =>
  decodeCommerceExternalIdentityConfiguration(input).pipe(
    Effect.map((configuration) => makeCommerceAuthenticationNamespaceRegistry(configuration)),
  );

export const commerceAuthenticationNamespaceRegistryLive = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Registry composition decodes untrusted deployment data once.
  input: unknown,
) => Layer.effect(AuthenticationNamespaceRegistry, makeCommerceAuthenticationNamespaceRegistryEffect(input));

const mapWorkloadAssertionFailure = (cause: unknown): CommercePortalAuthVerificationClientUnavailable => {
  const failure = new CommercePortalAuthVerificationClientUnavailable({
    reason: 'The Shell workload is not authorized to call Commerce verification',
  });
  return Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const requestContext = (): Effect.Effect<
  ExternalIdentityHttpWorkloadContextValue,
  CommercePortalAuthVerificationClientUnavailable
> =>
  Effect.serviceOption(ExternalIdentityHttpWorkloadContext).pipe(
    Effect.flatMap((context) =>
      Effect.fromOption(
        context,
        () =>
          new CommercePortalAuthVerificationClientUnavailable({
            reason: 'The external identity request context is unavailable',
          }),
      ),
    ),
  );

const makeWorkloadAssertion = (configuration: CommerceExternalIdentityConfiguration) =>
  Layer.succeed(CommercePortalAuthVerificationWorkloadAssertion, {
    acquire: Effect.fn('CommerceExternalIdentityWorkloadAssertion.acquire')(function* acquire(
      input: CommercePortalAuthVerificationWorkloadAssertionInput,
    ) {
      const context = yield* requestContext();
      const workloadAuthorization = yield* Effect.serviceOption(ExternalIdentityWorkloadAuthorization).pipe(
        Effect.flatMap((authorization) =>
          Effect.fromOption(
            authorization,
            () =>
              new CommercePortalAuthVerificationClientUnavailable({
                reason: 'The external identity workload authorization service is unavailable',
              }),
          ),
        ),
      );
      let grantInput: ExternalIdentityWorkloadGrantInput;
      if (context.targetAudience !== undefined) {
        grantInput =
          context.targetAuthenticationNamespaceId === undefined
            ? { operation: context.operation, targetAudience: context.targetAudience }
            : {
                operation: context.operation,
                targetAudience: context.targetAudience,
                targetAuthenticationNamespaceId: context.targetAuthenticationNamespaceId,
              };
      } else if (context.targetAuthenticationNamespaceId === undefined) {
        grantInput = { operation: context.operation };
      } else {
        grantInput = {
          operation: context.operation,
          targetAuthenticationNamespaceId: context.targetAuthenticationNamespaceId,
        };
      }
      yield* workloadAuthorization.authorizePrincipal(context.principal, grantInput).pipe(
        // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- The factory owns this exact validated grant configuration.
        Effect.provideService(ExternalIdentityHttpConfigurationService, {
          grants: configuration.grants,
          providerEndpointAudience: configuration.providerEndpointAudience,
        }),
        Effect.mapError(mapWorkloadAssertionFailure),
      );

      if (context.principal.tenantId !== input.request.tenantId) {
        return yield* new CommercePortalAuthVerificationClientUnavailable({
          reason: 'The external identity workload tenant changed during admission',
        });
      }
      if (input.request.authenticationNamespaceId !== configuration.authenticationNamespaceId) {
        return yield* new CommercePortalAuthVerificationClientUnavailable({
          reason: 'The external identity authentication namespace changed during admission',
        });
      }
      // The assertion minted below is addressed to the Commerce verification endpoint, so the only
      // audience this guard may compare is the one the request is *received* by: the verification
      // request is always built with `providerEndpointAudience`
      // (`external-identity/commerce-admission-observation.ts`), and the issuer is handed that same
      // value. A downstream `context.targetAudience` (a `gateway-context` call naming another
      // audience) is a different thing entirely — where it must agree with the admission it is
      // already checked, against the admission's own audience, in `validateSharedContext`.
      // Comparing it here instead closed every gateway-context call as `identity_unavailable`.
      if (input.request.audience !== configuration.providerEndpointAudience) {
        return yield* new CommercePortalAuthVerificationClientUnavailable({
          reason: 'The external identity receiving audience changed during admission',
        });
      }

      const issuer = yield* Effect.serviceOption(GatewayIssuer).pipe(
        Effect.flatMap((gatewayIssuer) =>
          Effect.fromOption(
            gatewayIssuer,
            () =>
              new CommercePortalAuthVerificationClientUnavailable({
                reason: 'The gateway assertion issuer is unavailable',
              }),
          ),
        ),
      );
      const response = yield* issuer
        .issue({ audience: configuration.providerEndpointAudience, principal: context.principal })
        .pipe(Effect.mapError(mapWorkloadAssertionFailure));
      return Redacted.make(`Bearer ${response.token}`);
    }),
  });

export const makeCommerceExternalIdentityWorkloadAssertionLayer = makeWorkloadAssertion;

const makeCommerceLayer = (configuration: CommerceExternalIdentityConfiguration): ExternalIdentityDeploymentLayer => {
  const httpConfiguration = Layer.succeed(ExternalIdentityHttpConfigurationService, {
    grants: configuration.grants,
    providerEndpointAudience: configuration.providerEndpointAudience,
  });
  /* oxlint-disable effect-native/no-layer-provide-in-library -- This deployment factory binds its validated provider origin and fresh assertion layer before handing the result to the application root. */
  const clientLayer = commercePortalAuthVerificationClientLive.pipe(
    Layer.provide(
      Layer.succeed(CommercePortalAuthVerificationClientConfigurationService, {
        baseUrl: new URL(COMMERCE_CUSTOMER_CONTEXT_API_PREFIX, configuration.providerOrigin).toString(),
      }),
    ),
    Layer.provide(makeWorkloadAssertion(configuration)),
  );
  const observationLayer = commerceAdmissionObservationLive(configuration).pipe(Layer.provide(clientLayer));
  /* oxlint-enable effect-native/no-layer-provide-in-library */
  return Layer.mergeAll(
    httpConfiguration,
    Layer.succeed(
      TrustedAuthenticationAdmissionService,
      makeTrustedAuthenticationAdmissionService({
        attesterPrincipalId: configuration.attesterPrincipalId,
        maxAdmissionWindowMillis: COMMERCE_ADMISSION_DEADLINE_MS,
      }),
    ),
    Layer.succeed(
      TrustedExternalSubjectAdmissionService,
      makeTrustedExternalSubjectAdmissionService({
        attesterPrincipalId: configuration.attesterPrincipalId,
        maxAdmissionWindowMillis: COMMERCE_ADMISSION_DEADLINE_MS,
      }),
    ),
    observationLayer,
  );
};

/**
 * Decode deployment data before constructing any trusted service.  A missing
 * or malformed configuration therefore fails layer construction and cannot
 * turn into a permissive, unavailable-only provider at request time.
 */
export const commerceExternalIdentityDeploymentLayer = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Deployment input is decoded before trusted layers are built.
  input: unknown,
): ExternalIdentityDeploymentLayer =>
  Layer.unwrap(decodeCommerceExternalIdentityConfiguration(input).pipe(Effect.orDie, Effect.map(makeCommerceLayer)));
