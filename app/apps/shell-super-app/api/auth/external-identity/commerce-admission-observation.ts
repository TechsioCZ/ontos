import {
  externalIdentityFailure,
  TrustedAdmissionObservation,
} from '@app/core-runtime/auth/external-identity-admission';
import type {
  AuthenticationAdmissionRequest,
  ExternalIdentityFailure,
  ExternalSubjectAdmissionMatch,
  TrustedAdmissionObservationService,
} from '@app/core-runtime/auth/external-identity-admission';
import {
  AuthenticationAdmissionObservationSchema,
  ExternalSubjectAdmissionObservationSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import type {
  AuthenticationAdmissionObservation,
  ExternalSubjectAdmissionObservation,
} from '@app/core-runtime/auth/external-identity-contracts';
import {
  COMMERCE_ADMISSION_DEADLINE_MS,
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
} from '@app/commerce-customer-context/portal-auth/contracts';
import {
  COMMERCE_PORTAL_AUTH_VERIFY_OPERATION,
  CommercePortalAuthVerificationRequestSchema,
} from '@app/commerce-customer-context/portal-auth/verification';
import { CommercePortalAuthVerificationClient } from '@app/commerce-customer-context/portal-auth/verification/client';
import { DateTime, Effect, Layer, Schema } from 'effect';

import type { CommerceExternalIdentityConfiguration } from '../commerce-external-identity.ts';
import { ExternalIdentityHttpWorkloadContext } from './request-context.ts';
import type { ExternalIdentityHttpWorkloadContextValue } from './request-context.ts';

type CommercePortalAuthVerificationClientPort = CommercePortalAuthVerificationClient['Service'];
type CommercePortalAuthVerificationRequest = Schema.Schema.Type<typeof CommercePortalAuthVerificationRequestSchema>;
type VerifyExternalAuthenticationResult = Effect.Success<
  ReturnType<CommercePortalAuthVerificationClient['Service']['verify']>
>;

const invalid = (reason: string, cause?: unknown): ExternalIdentityFailure => {
  const failure = externalIdentityFailure('identity_invalid', reason);
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const unavailable = (reason: string, cause?: unknown): ExternalIdentityFailure => {
  const failure = externalIdentityFailure('identity_unavailable', reason);
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const providerUnavailable = (cause: unknown): ExternalIdentityFailure =>
  unavailable('Commerce provider verification transport failed', cause);

const mapProviderResult = (cause: unknown): ExternalIdentityFailure =>
  invalid('Commerce provider verification response is invalid', cause);

const getRequestContext = (): Effect.Effect<ExternalIdentityHttpWorkloadContextValue, ExternalIdentityFailure> =>
  Effect.serviceOption(ExternalIdentityHttpWorkloadContext).pipe(
    Effect.flatMap((context) =>
      Effect.fromOption(context, () => unavailable('The external identity request context is unavailable')),
    ),
  );

const isWorkloadPrincipal = (context: ExternalIdentityHttpWorkloadContextValue): boolean =>
  context.principal.authMethod === 'api_key' && context.principal.impersonatedByPrincipalId === undefined;

const validateSharedContext = (
  context: ExternalIdentityHttpWorkloadContextValue,
  input: {
    readonly audience: string;
    readonly authContextRef: string;
    readonly authenticationNamespaceId: string;
    readonly subjectType: string;
    readonly tenantId: string;
  },
  configuration: CommerceExternalIdentityConfiguration,
): Effect.Effect<void, ExternalIdentityFailure> => {
  if (!isWorkloadPrincipal(context)) {
    return Effect.fail(invalid('The external identity workload principal is not a direct API-key principal'));
  }
  if (context.principal.tenantId !== input.tenantId) {
    return Effect.fail(invalid('The external identity workload tenant changed during admission'));
  }
  if (context.authenticationRef !== input.authContextRef) {
    return Effect.fail(invalid('The external identity authentication reference changed during admission'));
  }
  if (context.providerSubjectId.length === 0) {
    return Effect.fail(invalid('The external identity provider subject is unavailable'));
  }
  if (
    input.authenticationNamespaceId !== configuration.authenticationNamespaceId ||
    input.authenticationNamespaceId !== COMMERCE_AUTHENTICATION_NAMESPACE_ID ||
    input.subjectType !== 'user'
  ) {
    return Effect.fail(invalid('The external identity subject is not a Commerce user'));
  }
  if (context.targetAuthenticationNamespaceId !== input.authenticationNamespaceId) {
    return Effect.fail(invalid('The external identity target namespace changed during admission'));
  }
  if (context.targetAudience !== undefined && context.targetAudience !== input.audience) {
    return Effect.fail(invalid('The external identity target audience changed during admission'));
  }
  if (context.targetAudience === undefined && input.audience !== configuration.providerEndpointAudience) {
    return Effect.fail(invalid('The external identity provider audience changed during admission'));
  }
  return Effect.void;
};

const validateSubjectContext = (
  context: ExternalIdentityHttpWorkloadContextValue,
  input: ExternalSubjectAdmissionMatch,
  configuration: CommerceExternalIdentityConfiguration,
): Effect.Effect<void, ExternalIdentityFailure> =>
  validateSharedContext(context, input, configuration).pipe(
    Effect.flatMap(() =>
      context.operation === 'reserve' || context.operation === 'activate' || context.operation === 'status'
        ? Effect.void
        : Effect.fail(invalid('The external identity operation cannot admit a subject')),
    ),
    Effect.flatMap(() =>
      context.providerSubjectId === input.providerSubjectId
        ? Effect.void
        : Effect.fail(invalid('The external identity provider subject changed during admission')),
    ),
    Effect.flatMap(() => {
      const hasBinding = context.binding !== undefined;
      if (context.operation === 'reserve' && !hasBinding) {
        return Effect.void;
      }
      if ((context.operation === 'activate' || context.operation === 'status') && hasBinding) {
        return Effect.void;
      }
      return Effect.fail(invalid('The external identity binding projection is inconsistent'));
    }),
  );

const validateAuthenticationContext = (
  context: ExternalIdentityHttpWorkloadContextValue,
  input: AuthenticationAdmissionRequest,
  configuration: CommerceExternalIdentityConfiguration,
): Effect.Effect<void, ExternalIdentityFailure> =>
  validateSharedContext(context, input, configuration).pipe(
    Effect.flatMap(() =>
      context.operation === 'resolve' || context.operation === 'gateway-context'
        ? Effect.void
        : Effect.fail(invalid('The external identity operation cannot admit authentication')),
    ),
    Effect.flatMap(() => {
      const { binding } = context;
      if (binding === undefined) {
        return Effect.fail(invalid('The external identity binding projection is unavailable'));
      }
      if (binding.authBindingId !== input.authBindingId || binding.principalId !== input.principalId) {
        return Effect.fail(invalid('The external identity binding changed during admission'));
      }
      if (!Number.isSafeInteger(binding.bindingRevision) || binding.bindingRevision < 1) {
        return Effect.fail(invalid('The external identity binding revision is malformed'));
      }
      return Effect.void;
    }),
  );

const makeProviderRequest = (input: {
  readonly admission: AuthenticationAdmissionRequest | ExternalSubjectAdmissionMatch;
  readonly configuration: CommerceExternalIdentityConfiguration;
  readonly context: ExternalIdentityHttpWorkloadContextValue;
}): Effect.Effect<CommercePortalAuthVerificationRequest, ExternalIdentityFailure> =>
  Schema.decodeEffect(CommercePortalAuthVerificationRequestSchema)({
    // The request is received by Commerce; the Core audience remains bound in the admission below.
    audience: input.configuration.providerEndpointAudience,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    nonce: input.admission.nonce,
    operation: COMMERCE_PORTAL_AUTH_VERIFY_OPERATION,
    operationRef: input.admission.operationRef,
    providerSubjectId: input.context.providerSubjectId,
    sessionRef: input.context.authenticationRef,
    subjectType: 'user',
    tenantId: input.admission.tenantId,
  }).pipe(Effect.mapError((cause) => invalid('The Commerce provider request is malformed', cause)));

const matchesProviderResult = (
  result: Extract<VerifyExternalAuthenticationResult, { readonly outcome: 'ALLOWED' }>,
  request: CommercePortalAuthVerificationRequest,
): boolean =>
  result.authenticationNamespaceId === request.authenticationNamespaceId &&
  result.providerSubjectId === request.providerSubjectId &&
  result.sessionRef === request.sessionRef &&
  result.subjectType === request.subjectType &&
  result.tenantId === request.tenantId &&
  result.nonce === request.nonce &&
  result.enrollmentAttemptId === request.enrollmentAttemptId;

const observedExpiry = (
  result: VerifyExternalAuthenticationResult,
  deadlineMillis: number,
): Effect.Effect<DateTime.Utc, ExternalIdentityFailure> => {
  const observedAt = DateTime.toEpochMillis(result.observedAt);
  return Number.isFinite(observedAt)
    ? Effect.succeed(DateTime.makeUnsafe(observedAt + deadlineMillis))
    : Effect.fail(invalid('Commerce provider observation time is invalid'));
};

const observeSubjectResult = (
  result: VerifyExternalAuthenticationResult,
  request: CommercePortalAuthVerificationRequest,
  input: ExternalSubjectAdmissionMatch,
): Effect.Effect<ExternalSubjectAdmissionObservation, ExternalIdentityFailure> => {
  if (result.outcome === 'UNAVAILABLE') {
    return Effect.fail(unavailable('Commerce provider verification is unavailable'));
  }
  if (result.outcome === 'REJECTED') {
    return Effect.fail(externalIdentityFailure('identity_forbidden', 'Commerce provider verification was rejected'));
  }
  if (!matchesProviderResult(result, request)) {
    return Effect.fail(invalid('Commerce provider verification did not match the operation'));
  }
  return observedExpiry(result, COMMERCE_ADMISSION_DEADLINE_MS).pipe(
    Effect.flatMap((expiresAt) =>
      Schema.decodeEffect(ExternalSubjectAdmissionObservationSchema)({
        audience: input.audience,
        authContextRef: input.authContextRef,
        authenticationNamespaceId: input.authenticationNamespaceId,
        expiresAt,
        nonce: input.nonce,
        observedAt: result.observedAt,
        operationRef: input.operationRef,
        providerSubjectId: input.providerSubjectId,
        subjectType: input.subjectType,
        tenantId: input.tenantId,
      }),
    ),
    Effect.mapError((cause) => mapProviderResult(cause)),
  );
};

const observeAuthenticationResult = (
  result: VerifyExternalAuthenticationResult,
  request: CommercePortalAuthVerificationRequest,
  input: AuthenticationAdmissionRequest,
  context: ExternalIdentityHttpWorkloadContextValue,
): Effect.Effect<AuthenticationAdmissionObservation, ExternalIdentityFailure> => {
  if (result.outcome === 'UNAVAILABLE') {
    return Effect.fail(unavailable('Commerce provider verification is unavailable'));
  }
  if (result.outcome === 'REJECTED') {
    return Effect.fail(externalIdentityFailure('identity_forbidden', 'Commerce provider verification was rejected'));
  }
  if (!matchesProviderResult(result, request)) {
    return Effect.fail(invalid('Commerce provider verification did not match the operation'));
  }
  const { binding } = context;
  if (binding === undefined) {
    return Effect.fail(invalid('The external identity binding projection is unavailable'));
  }
  return observedExpiry(result, COMMERCE_ADMISSION_DEADLINE_MS).pipe(
    Effect.flatMap((expiresAt) =>
      Schema.decodeEffect(AuthenticationAdmissionObservationSchema)({
        audience: input.audience,
        authBindingId: input.authBindingId,
        authContextRef: input.authContextRef,
        authenticationNamespaceId: input.authenticationNamespaceId,
        bindingRevision: binding.bindingRevision,
        expiresAt,
        nonce: input.nonce,
        observedAt: result.observedAt,
        operationRef: input.operationRef,
        principalId: input.principalId,
        tenantId: input.tenantId,
      }),
    ),
    Effect.mapError((cause) => mapProviderResult(cause)),
  );
};

const verifyProvider = (
  client: CommercePortalAuthVerificationClientPort,
  request: CommercePortalAuthVerificationRequest,
): Effect.Effect<VerifyExternalAuthenticationResult, ExternalIdentityFailure> =>
  client.verify(request, { requestCorrelation: request.operationRef }).pipe(Effect.mapError(providerUnavailable));

export const makeCommerceAdmissionObservationService = (
  client: CommercePortalAuthVerificationClientPort,
  configuration: CommerceExternalIdentityConfiguration,
): TrustedAdmissionObservationService => ({
  observeAuthentication: Effect.fn('CommerceAdmissionObservation.observeAuthentication')(
    function* observeAuthentication(input) {
      const context = yield* getRequestContext();
      yield* validateAuthenticationContext(context, input, configuration);
      const providerRequest = yield* makeProviderRequest({ admission: input, configuration, context });
      const result = yield* verifyProvider(client, providerRequest);
      return yield* observeAuthenticationResult(result, providerRequest, input, context);
    },
  ),
  observeExternalSubject: Effect.fn('CommerceAdmissionObservation.observeExternalSubject')(
    function* observeSubject(input) {
      const context = yield* getRequestContext();
      yield* validateSubjectContext(context, input, configuration);
      const providerRequest = yield* makeProviderRequest({ admission: input, configuration, context });
      const result = yield* verifyProvider(client, providerRequest);
      return yield* observeSubjectResult(result, providerRequest, input);
    },
  ),
});

export const commerceAdmissionObservationLive = (configuration: CommerceExternalIdentityConfiguration) =>
  Layer.effect(
    TrustedAdmissionObservation,
    Effect.gen(function* makeCommerceAdmissionObservationEffect() {
      const client = yield* CommercePortalAuthVerificationClient;
      return makeCommerceAdmissionObservationService(client, configuration);
    }),
  );
